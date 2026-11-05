using System.Reflection;
using System.Reflection.Emit;
using System.Text.Json;

// The startup bridge is compiled unchanged against its narrow host interfaces;
// the actual reflection boundary is exercised with a separate dynamic assembly.
namespace MediaBrowser.Common.Configuration
{
    public interface IApplicationPaths { string WebPath { get; } }
}
namespace MediaBrowser.Controller
{
    public interface IServerApplicationHost { Version ApplicationVersion { get; } }
}
namespace MediaBrowser.Controller.Configuration
{
    public interface IServerConfigurationManager { TestNetworkConfiguration NetworkConfiguration { get; } }
    public sealed record TestNetworkConfiguration(string BaseUrl);
}
namespace MediaBrowser.Common.Net
{
    public static class TestNetworkExtensions
    {
        public static MediaBrowser.Controller.Configuration.TestNetworkConfiguration GetNetworkConfiguration(
            this MediaBrowser.Controller.Configuration.IServerConfigurationManager manager) => manager.NetworkConfiguration;
    }
}
namespace ServerTests
{
    public sealed record TestHost(Version ApplicationVersion) : MediaBrowser.Controller.IServerApplicationHost;
    public sealed record TestPaths(string WebPath) : MediaBrowser.Common.Configuration.IApplicationPaths;
    public sealed record TestConfiguration(string BaseUrl) : MediaBrowser.Controller.Configuration.IServerConfigurationManager
    {
        public MediaBrowser.Controller.Configuration.TestNetworkConfiguration NetworkConfiguration => new(BaseUrl);
    }
    public sealed record TransformationPayload(Guid Id, string Pattern, string CallbackMethod, string CallbackClass, string CallbackAssembly)
    {
        public static TransformationPayload Parse(string json)
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            return new(root.GetProperty("id").GetGuid(), root.GetProperty("fileNamePattern").GetString()!,
                root.GetProperty("callbackMethod").GetString()!, root.GetProperty("callbackClass").GetString()!,
                root.GetProperty("callbackAssembly").GetString()!);
        }
    }
    public static class TransformationRegistry
    {
        public static Dictionary<Guid, TransformationPayload> Active { get; } = new();
        public static List<Guid> Removed { get; } = new();
        public static string? FailPattern { get; set; }
        public static void Register(TransformationPayload payload)
        {
            if (payload.Pattern == FailPattern) throw new InvalidOperationException("Simulated registration failure.");
            Active.Add(payload.Id, payload);
        }
        public static void Remove(Guid id)
        {
            Removed.Add(id);
            Active.Remove(id);
        }
        public static void LoadDependency()
        {
            var name = new AssemblyName("Jellyfin.Plugin.FileTransformation") { Version = new Version(3, 0, 0, 0) };
            AssemblyBuilder assembly = AssemblyBuilder.DefineDynamicAssembly(name, AssemblyBuilderAccess.Run);
            TypeBuilder bridge = assembly.DefineDynamicModule(name.Name!).DefineType(
                "Jellyfin.Plugin.FileTransformation.PluginInterface", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
            MethodBuilder register = bridge.DefineMethod("RegisterTransformation", MethodAttributes.Public | MethodAttributes.Static,
                typeof(void), new[] { typeof(TransformationPayload) });
            ILGenerator registerBody = register.GetILGenerator();
            registerBody.Emit(OpCodes.Ldarg_0);
            registerBody.Emit(OpCodes.Call, typeof(TransformationRegistry).GetMethod(nameof(Register))!);
            registerBody.Emit(OpCodes.Ret);
            MethodBuilder remove = bridge.DefineMethod("RemoveTransformation", MethodAttributes.Public | MethodAttributes.Static,
                typeof(void), new[] { typeof(Guid) });
            ILGenerator removeBody = remove.GetILGenerator();
            removeBody.Emit(OpCodes.Ldarg_0);
            removeBody.Emit(OpCodes.Call, typeof(TransformationRegistry).GetMethod(nameof(Remove))!);
            removeBody.Emit(OpCodes.Ret);
            bridge.CreateType();
        }
    }
}
