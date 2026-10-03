import UIKit
import Capacitor
import Darwin

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// The shared TypeScript core owns formats and encryption. This small adapter
// supplies atomic replacement and fsync before acknowledging a mobile write.
class TaskasaurViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ReplicaStoragePlugin())
    }
}

@objc(ReplicaStoragePlugin)
public class ReplicaStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReplicaStoragePlugin"
    public let jsName = "ReplicaStorage"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)]
    private let io = DispatchQueue(label: "taskasaur.replica.storage")
    @objc func read(_ call: CAPPluginCall) {
        guard let relative = call.getString("path"), relative.hasPrefix("replica/"), !relative.split(separator: "/").contains("..") else { call.reject("Invalid replica path"); return }
        io.async {
            do {
                let root = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let file = root.appendingPathComponent(relative)
                if !FileManager.default.fileExists(atPath: file.path) { call.resolve(["data": NSNull()]); return }
                call.resolve(["data": try Data(contentsOf: file).base64EncodedString()])
            } catch { call.reject("Replica read failed", nil, error) }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let relative = call.getString("path"), relative.hasPrefix("replica/"),
              !relative.split(separator: "/").contains(".."),
              let encoded = call.getString("data"), let bytes = Data(base64Encoded: encoded) else {
            call.reject("Invalid replica write"); return
        }
        io.async {
            do {
                let root = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let destination = root.appendingPathComponent(relative)
                try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                var replica = root.appendingPathComponent("replica")
                var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
                try replica.setResourceValues(attributes)
                try bytes.write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                let file = Darwin.open(destination.path, O_RDONLY)
                guard file >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                let synced = fsync(file); Darwin.close(file)
                guard synced == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                let directory = Darwin.open(destination.deletingLastPathComponent().path, O_RDONLY)
                if directory >= 0 { fsync(directory); Darwin.close(directory) }
                call.resolve()
            } catch { call.reject("Replica write failed", nil, error) }
        }
    }
}
