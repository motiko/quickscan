import Capacitor
import UIKit

/// Serves the Next.js static export's page files. Capacitor's default router sends every
/// path without an extension to the root index.html (an SPA assumption), so a full page
/// load of /scan or /doc would show the gallery. Here /scan → scan.html, falling back to
/// scan/index.html and then index.html.
struct StaticExportRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        guard URL(fileURLWithPath: path).pathExtension.isEmpty else { return basePath + path }
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        if !trimmed.isEmpty {
            for candidate in [trimmed + ".html", trimmed + "/index.html"]
            where FileManager.default.fileExists(atPath: basePath + candidate) {
                return basePath + candidate
            }
        }
        return basePath + "/index.html"
    }
}

class MainViewController: CAPBridgeViewController {
    override func router() -> Router {
        StaticExportRouter()
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativePasskeyPlugin())
    }
}

