package app.mitrasto;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The app installs its own update (spec §5.2.1b).
 *
 * The APK is not on a store, so an update used to mean leaving the app: a browser
 * download, finding the file, and Android's "this file may be harmful" on the
 * way. Here the release's APK is streamed straight into a
 * {@link PackageInstaller} session and handed to the system, which asks the rider
 * to confirm — or, where the platform allows an app to update itself unattended,
 * does not ask at all.
 *
 * What makes this safe is not in this file. Android only installs an APK over an
 * app when both are signed with the same key, and the session is pinned to this
 * package's own name, so the one thing a session opened here can do is replace
 * this app with a build signed by whoever signed this one. The URL check below
 * is the second line: it keeps the download on this project's own releases.
 *
 * Everything else — which release is newer, when to offer it — is decided in
 * TypeScript (`client/mobile/src/services/appUpdate.ts`).
 */
@CapacitorPlugin(name = "AppUpdate")
public class UpdatePlugin extends Plugin {

    private static final String TAG = "TMUpdate";

    /** The only place an update may come from: this repository's own release assets. */
    private static final String DOWNLOAD_PREFIX = "https://github.com/estebantorrg/transmilenio/releases/download/";
    private static final String ACTION_INSTALL_STATUS = "app.mitrasto.INSTALL_STATUS";
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    /** A release APK is about 13 MB; anything past this is not one. */
    private static final long MAX_APK_BYTES = 150L * 1024 * 1024;

    // ─── Error codes (contract with appUpdate.ts) ─────────
    private static final String ERR_URL = "BAD_URL";
    private static final String ERR_PERMISSION = "NOT_ALLOWED";
    private static final String ERR_DOWNLOAD = "DOWNLOAD_FAILED";
    private static final String ERR_CANCELLED = "CANCELLED";
    private static final String ERR_INSTALL = "INSTALL_FAILED";
    private static final String ERR_BUSY = "BUSY";

    private final Object lock = new Object();
    /** The one update in flight; a second tap does not start a second download. */
    private PluginCall pending = null;
    private BroadcastReceiver statusReceiver = null;

    @Override
    protected void handleOnDestroy() {
        unregisterStatusReceiver();
        super.handleOnDestroy();
    }

    /**
     * Download the release APK at `url` and hand it to the system installer.
     *
     * Resolves once the system has taken the update — which, for an app replacing
     * itself, is normally the last thing this process does. Rejects with one of
     * the codes above when it cannot get that far.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith(DOWNLOAD_PREFIX) || !url.endsWith(".apk")) {
            call.reject("La actualización no viene de las versiones del proyecto", ERR_URL);
            return;
        }
        synchronized (lock) {
            if (pending != null) {
                call.reject("Ya hay una actualización en curso", ERR_BUSY);
                return;
            }
            pending = call;
        }
        call.setKeepAlive(true);

        // Asked before the download, not after: the answer decides whether 13 MB
        // of the rider's data is worth spending at all.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            startActivityForResult(call, settings, "installPermissionResult");
            return;
        }
        startDownload(call, url);
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            fail(call, "Sin permiso para instalar la actualización", ERR_PERMISSION);
            return;
        }
        startDownload(call, call.getString("url", ""));
    }

    /** Off the plugin thread: every other plugin call would queue behind 13 MB. */
    private void startDownload(PluginCall call, String url) {
        new Thread(() -> downloadAndInstall(call, url), "tm-update").start();
    }

    private void downloadAndInstall(PluginCall call, String url) {
        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.Session session = null;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                fail(call, "La descarga respondió " + status, ERR_DOWNLOAD);
                return;
            }
            // GitHub redirects a release asset to its storage host; the connection
            // must still be an encrypted one when it gets there.
            if (!"https".equals(connection.getURL().getProtocol())) {
                fail(call, "La descarga dejó de ser segura", ERR_DOWNLOAD);
                return;
            }
            long total = connection.getContentLengthLong();
            if (total > MAX_APK_BYTES) {
                fail(call, "El archivo no es una versión de la app", ERR_DOWNLOAD);
                return;
            }

            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL
            );
            // This session can replace this app and nothing else.
            params.setAppPackageName(getContext().getPackageName());
            if (total > 0) params.setSize(total);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // An app updating itself may be spared the confirmation; the system
                // decides, and asks anyway when it will not (see the receiver).
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            }
            int sessionId = installer.createSession(params);
            session = installer.openSession(sessionId);

            long received = 0;
            int lastPercent = -1;
            try (InputStream in = connection.getInputStream();
                 OutputStream out = session.openWrite("base.apk", 0, total > 0 ? total : -1)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    received += read;
                    if (received > MAX_APK_BYTES) throw new java.io.IOException("larger than a release");
                    out.write(buffer, 0, read);
                    int percent = total > 0 ? (int) (received * 100 / total) : -1;
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        JSObject progress = new JSObject();
                        progress.put("percent", percent);
                        notifyListeners("updateProgress", progress);
                    }
                }
                session.fsync(out);
            }

            registerStatusReceiver();
            Intent statusIntent = new Intent(ACTION_INSTALL_STATUS).setPackage(getContext().getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            // Mutable: the system writes the outcome into this intent.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent statusCallback = PendingIntent.getBroadcast(getContext(), sessionId, statusIntent, flags);
            JSObject installing = new JSObject();
            installing.put("percent", 100);
            notifyListeners("updateInstalling", installing);
            session.commit(statusCallback.getIntentSender());
            session.close();
            session = null;
        } catch (Exception error) {
            Log.w(TAG, "update failed before it reached the installer", error);
            if (session != null) session.abandon();
            fail(call, "No se pudo descargar la actualización", ERR_DOWNLOAD);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** What the system did with the session: asked, installed, or refused. */
    private void onInstallStatus(Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.i(TAG, "install status " + status + (message == null ? "" : " — " + message));

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // The system wants the rider's confirmation: show its own dialog.
            Intent confirm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null && getActivity() != null) {
                getActivity().startActivity(confirm);
                return;
            }
            status = PackageInstaller.STATUS_FAILURE;
        }

        PluginCall call;
        synchronized (lock) {
            call = pending;
        }
        if (call == null) return;
        if (status == PackageInstaller.STATUS_SUCCESS) {
            // Reached only when the update did not restart this process.
            synchronized (lock) {
                pending = null;
            }
            call.resolve();
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            fail(call, "Actualización cancelada", ERR_CANCELLED);
        } else {
            fail(call, message == null ? "El sistema rechazó la actualización" : message, ERR_INSTALL);
        }
    }

    private void fail(PluginCall call, String message, String code) {
        synchronized (lock) {
            if (pending == call) pending = null;
        }
        call.reject(message, code);
    }

    private void registerStatusReceiver() {
        synchronized (lock) {
            if (statusReceiver != null) return;
            statusReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    onInstallStatus(intent);
                }
            };
        }
        // Not exported: only the system, through the PendingIntent above, reaches it.
        ContextCompat.registerReceiver(
            getContext(),
            statusReceiver,
            new IntentFilter(ACTION_INSTALL_STATUS),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    private void unregisterStatusReceiver() {
        BroadcastReceiver receiver;
        synchronized (lock) {
            receiver = statusReceiver;
            statusReceiver = null;
        }
        if (receiver != null) getContext().unregisterReceiver(receiver);
    }
}
