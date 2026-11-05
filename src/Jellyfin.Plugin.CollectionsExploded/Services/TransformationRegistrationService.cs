using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using Jellyfin.Plugin.CollectionsExploded.Transformations;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.CollectionsExploded.Services;

/// <summary>Startup integration without binding to the dependency's assembly load context.</summary>
public sealed class TransformationRegistrationService : IHostedService
{
    public const string FileTransformationPluginId = "5e87cc92-571a-4d8d-8d98-d2d4147f9f90";
    public static readonly Version MinimumServerVersion = new(12, 0, 0);

    private readonly ILogger<TransformationRegistrationService> _logger;
    private readonly IServerApplicationHost _applicationHost;
    private readonly IServerConfigurationManager _configurationManager;
    private readonly IApplicationPaths _applicationPaths;
    private readonly List<Guid> _registeredIds = new();
    private MethodInfo? _removeTransformation;

    public TransformationRegistrationService(ILogger<TransformationRegistrationService> logger,
        IServerApplicationHost applicationHost, IServerConfigurationManager configurationManager,
        IApplicationPaths applicationPaths)
    {
        _logger = logger;
        _applicationHost = applicationHost;
        _configurationManager = configurationManager;
        _applicationPaths = applicationPaths;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (_registeredIds.Count > 0 || cancellationToken.IsCancellationRequested) return Task.CompletedTask;
        if (_applicationHost.ApplicationVersion < MinimumServerVersion)
        {
            _logger.LogWarning("Collections Exploded requires Jellyfin 12.0.0 or newer; web integration is disabled.");
            return Task.CompletedTask;
        }
        Assembly? dependency = AssemblyLoadContext.All.SelectMany(context => context.Assemblies)
            .FirstOrDefault(assembly => assembly.GetName().Name == "Jellyfin.Plugin.FileTransformation");
        if (dependency is null || dependency.GetName().Version?.Major is not >= 3)
        {
            _logger.LogWarning("Collections Exploded requires File Transformation 3 or newer. Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json and restart Jellyfin.");
            return Task.CompletedTask;
        }
        try
        {
            Type? bridge = dependency.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            MethodInfo? register = bridge?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
            if (register is null || register.GetParameters().Length != 1)
            {
                throw new InvalidOperationException("File Transformation's registration API is unavailable.");
            }
            _removeTransformation = bridge?.GetMethod("RemoveTransformation", BindingFlags.Public | BindingFlags.Static,
                binder: null, types: new[] { typeof(Guid) }, modifiers: null);
            WebTransformations.BasePathProvider = () => _configurationManager.GetNetworkConfiguration().BaseUrl;
            RegisterAndTrack(register, Plugin.PluginGuid, "index.html", nameof(WebTransformations.TransformIndex));

            // File Transformation uses one pipeline per matching filename pattern. Exact
            // discovered paths keep this plugin compatible with other transformations.
            IReadOnlyList<WebAssetRegistration> assets = WebAssetScanner.Discover(
                _applicationPaths.WebPath, Plugin.PluginGuid,
                (path, exception) => _logger.LogWarning(exception, "Collections Exploded could not inspect web asset {Path}.", path));
            foreach (WebAssetRegistration asset in assets)
            {
                RegisterAndTrack(register, asset.Id, asset.RelativePath, nameof(WebTransformations.TransformJavaScript));
            }
            _logger.LogInformation("Collections Exploded registered index.html and {ChunkCount} native item detail web transformations.", assets.Count);
            if (assets.Count == 0)
            {
                _logger.LogWarning("Collections Exploded found no compatible native item detail chunk under {WebPath}; native collection rendering remains available. Check the server-hosted web installation and supported web versions.", _applicationPaths.WebPath);
            }
        }
        catch (Exception exception)
        {
            // The enhancement must never stop Jellyfin startup when its dependency changes.
            RemoveRegistrations();
            _logger.LogError(Unwrap(exception), "Collections Exploded could not register its web transformations.");
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        RemoveRegistrations();
        return Task.CompletedTask;
    }

    private void RemoveRegistrations()
    {
        if (_removeTransformation is not null)
        {
            foreach (Guid id in _registeredIds)
            {
                try
                {
                    _removeTransformation.Invoke(null, new object[] { id });
                }
                catch (Exception exception)
                {
                    _logger.LogDebug(Unwrap(exception), "Collections Exploded could not remove its web transformation {Id}.", id);
                }
            }
        }
        _registeredIds.Clear();
    }

    private void RegisterAndTrack(MethodInfo register, Guid id, string fileNamePattern, string callbackMethod)
    {
        string json = CreateRegistrationPayload(id, fileNamePattern, callbackMethod);
        // JObject must be created in the registration method's own Newtonsoft context.
        Type payloadType = register.GetParameters()[0].ParameterType;
        MethodInfo? parse = payloadType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static,
            binder: null, types: new[] { typeof(string) }, modifiers: null);
        object payload = parse?.Invoke(null, new object[] { json })
            ?? throw new InvalidOperationException("File Transformation's payload does not support Parse(string).");
        register.Invoke(null, new[] { payload });
        _registeredIds.Add(id);
    }

    internal static string CreateRegistrationPayload(Guid id, string fileNamePattern, string callbackMethod) => JsonSerializer.Serialize(new
    {
        id,
        fileNamePattern,
        callbackAssembly = typeof(WebTransformations).Assembly.FullName,
        callbackClass = typeof(WebTransformations).FullName,
        callbackMethod
    });

    private static Exception Unwrap(Exception exception) =>
        exception is TargetInvocationException { InnerException: not null } invocation ? invocation.InnerException! : exception;
}
