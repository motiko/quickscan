package app.quickscan;

import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.IOException;
import java.io.InputStream;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new StaticExportWebViewClient(bridge, getAssets()));
    }

    /**
     * Serves the Next.js static export's page files. Capacitor's local server sends every path
     * without an extension to the root index.html (an SPA assumption), so a full page load of
     * /scan or /doc would show the gallery. Here /scan → scan.html, falling back to
     * scan/index.html and then Capacitor's own handling. Same as StaticExportRouter on iOS.
     */
    static class StaticExportWebViewClient extends BridgeWebViewClient {

        private final Bridge bridge;
        private final AssetManager assets;

        StaticExportWebViewClient(Bridge bridge, AssetManager assets) {
            super(bridge);
            this.bridge = bridge;
            this.assets = assets;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String path = url.getPath();
            String last = url.getLastPathSegment();
            boolean local = bridge.getHost().equals(url.getHost());
            if (local && path != null && last != null && !last.contains(".")) {
                String trimmed = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
                for (String candidate : new String[] { trimmed + ".html", trimmed + "/index.html" }) {
                    if (assetExists("public" + candidate)) {
                        Uri page = url.buildUpon().path(candidate).build();
                        return super.shouldInterceptRequest(view, new RewrittenRequest(request, page));
                    }
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        private boolean assetExists(String path) {
            try (InputStream ignored = assets.open(path)) {
                return true;
            } catch (IOException e) {
                return false;
            }
        }
    }

    /** The same request for another URL on the app's own host. */
    static class RewrittenRequest implements WebResourceRequest {

        private final WebResourceRequest original;
        private final Uri url;

        RewrittenRequest(WebResourceRequest original, Uri url) {
            this.original = original;
            this.url = url;
        }

        @Override
        public Uri getUrl() {
            return url;
        }

        @Override
        public boolean isForMainFrame() {
            return original.isForMainFrame();
        }

        @Override
        public boolean isRedirect() {
            return original.isRedirect();
        }

        @Override
        public boolean hasGesture() {
            return original.hasGesture();
        }

        @Override
        public String getMethod() {
            return original.getMethod();
        }

        @Override
        public Map<String, String> getRequestHeaders() {
            return original.getRequestHeaders();
        }
    }
}
