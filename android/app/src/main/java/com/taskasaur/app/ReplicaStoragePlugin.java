package com.taskasaur.app;

import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/** AtomicFile syncs and replaces app-private data before the promise resolves. */
@CapacitorPlugin(name = "ReplicaStorage")
public class ReplicaStoragePlugin extends Plugin {
    private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newSingleThreadExecutor();
    @Override protected void handleOnDestroy() { io.shutdown(); }
    @PluginMethod public void remove(PluginCall call) {
        String relative = call.getString("path");
        if (relative == null || !relative.startsWith("replica/")) { call.reject("Invalid replica path"); return; }
        io.execute(() -> {
            try {
                File root = getContext().getFilesDir(), file = new File(root, relative);
                if (!file.getCanonicalPath().startsWith(new File(root, "replica").getCanonicalPath() + File.separator)) throw new IllegalArgumentException("Invalid storage path");
                for (String suffix : new String[]{"", ".bak", ".new", ".tmp"}) {
                    File part = new File(file.getPath() + suffix);
                    if (part.exists() && !part.delete()) throw new java.io.IOException("Cannot delete replica data");
                }
                if (file.getParentFile().isDirectory()) {
                    java.io.FileDescriptor dir = android.system.Os.open(file.getParent(), android.system.OsConstants.O_RDONLY, 0);
                    try { android.system.Os.fsync(dir); } finally { android.system.Os.close(dir); }
                }
                call.resolve();
            } catch (Exception error) { call.reject("Replica deletion failed", error); }
        });
    }
    @PluginMethod public void read(PluginCall call) {
        String relative = call.getString("path");
        if (relative == null || !relative.startsWith("replica/")) { call.reject("Invalid replica path"); return; }
        io.execute(() -> {
            try {
                File root = getContext().getFilesDir(), file = new File(root, relative);
                if (!file.getCanonicalPath().startsWith(new File(root, "replica").getCanonicalPath() + File.separator)) throw new IllegalArgumentException("Invalid storage path");
                JSObject value = new JSObject();
                try { value.put("data", Base64.encodeToString(new AtomicFile(file).readFully(), Base64.NO_WRAP)); }
                catch (java.io.FileNotFoundException missing) { value.put("data", org.json.JSONObject.NULL); }
                call.resolve(value);
            } catch (Exception error) { call.reject("Replica read failed", error); }
        });
    }
    @PluginMethod
    public void write(PluginCall call) {
        String relative = call.getString("path"), encoded = call.getString("data");
        if (relative == null || !relative.startsWith("replica/") || encoded == null) {
            call.reject("Invalid replica write"); return;
        }
        io.execute(() -> {
            AtomicFile target = null;
            FileOutputStream stream = null;
            try {
                File root = getContext().getFilesDir();
                File destination = new File(root, relative);
                if (!destination.getCanonicalPath().startsWith(new File(root, "replica").getCanonicalPath() + File.separator)) throw new IllegalArgumentException("Invalid storage path");
                if (!destination.getParentFile().isDirectory() && !destination.getParentFile().mkdirs()) throw new java.io.IOException("Cannot create replica directory");
                target = new AtomicFile(destination);
                stream = target.startWrite();
                stream.write(Base64.decode(encoded, Base64.DEFAULT));
                stream.getFD().sync();
                target.finishWrite(stream);
                call.resolve();
            } catch (Exception error) {
                if (target != null && stream != null) target.failWrite(stream);
                call.reject("Replica write failed", error);
            }
        });
    }
}
