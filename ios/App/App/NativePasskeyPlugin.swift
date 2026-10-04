import AuthenticationServices
import Capacitor
import UIKit

/// Passkey PRF for the app (src/lib/native-passkey.ts). The web view can't use WebAuthn for
/// our domain: its origin is capacitor://localhost. ASAuthorization can, through the
/// `webcredentials:` associated domain (App.entitlements + the site's
/// apple-app-site-association), and so reaches the same iCloud Keychain passkeys the website
/// made.
///
/// Only assertions (unlock). The PRF output is the secret that unwraps the vault key: it is
/// returned once to the caller and not kept or logged here.
@objc(NativePasskeyPlugin)
public class NativePasskeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePasskeyPlugin"
    public let jsName = "NativePasskey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPrf", returnType: CAPPluginReturnPromise),
    ]

    private var pending: AssertionRequest?

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 18.0, *) {
            call.resolve(["supported": true])
        } else {
            call.resolve(["supported": false])
        }
    }

    /// `rpId`, and `credentials: [{ id: base64url credential id, salt: base64 PRF salt }]`.
    /// Resolves `{ credentialId: base64url, first: base64 PRF output }` for the passkey the
    /// user picked; rejects with code `unsupported | cancelled | not-associated | failed`.
    @objc func getPrf(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.reject("Passkey PRF needs iOS 18 or later.", "unsupported")
            return
        }
        guard let rpId = call.getString("rpId"), !rpId.isEmpty,
              let entries = call.getArray("credentials", JSObject.self), !entries.isEmpty else {
            call.reject("rpId and credentials are required.", "failed")
            return
        }

        var descriptors: [ASAuthorizationPlatformPublicKeyCredentialDescriptor] = []
        var salts: [Data: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues] = [:]
        for entry in entries {
            guard let id = (entry["id"] as? String).flatMap(Self.base64urlDecode),
                  let salt = (entry["salt"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
                call.reject("Malformed credential id or salt.", "failed")
                return
            }
            descriptors.append(ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id))
            salts[id] = .init(saltInput1: salt)
        }

        var challenge = Data(count: 32)
        let status = challenge.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else {
            call.reject("No randomness for the challenge.", "failed")
            return
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.allowedCredentials = descriptors
        request.userVerificationPreference = .required
        request.prf = .perCredentialInputValues(salts)

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let assertion = AssertionRequest(call: call, anchor: self.bridge?.viewController?.view.window) { [weak self] in
                self?.pending = nil
            }
            self.pending = assertion
            assertion.perform(request)
        }
    }

    static func base64urlDecode(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    static func base64urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// One ASAuthorizationController run; kept alive by the plugin until it finishes.
private final class AssertionRequest: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private let call: CAPPluginCall
    private let anchor: UIWindow?
    private let done: () -> Void

    init(call: CAPPluginCall, anchor: UIWindow?, done: @escaping () -> Void) {
        self.call = call
        self.anchor = anchor
        self.done = done
    }

    func perform(_ request: ASAuthorizationRequest) {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { done() }
        guard #available(iOS 18.0, *),
              let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            call.reject("Unexpected credential type.", "failed")
            return
        }
        guard let prf = credential.prf else {
            call.reject("The passkey returned no PRF output.", "unsupported")
            return
        }
        let first = prf.first.withUnsafeBytes { Data($0) }
        call.resolve([
            "credentialId": NativePasskeyPlugin.base64urlEncode(credential.credentialID),
            "first": first.base64EncodedString(),
        ])
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        defer { done() }
        let nsError = error as NSError
        let code: String
        switch (nsError.domain, nsError.code) {
        case (ASAuthorizationError.errorDomain, ASAuthorizationError.canceled.rawValue):
            code = "cancelled"
        case (ASAuthorizationError.errorDomain, ASAuthorizationError.failed.rawValue)
            where nsError.localizedDescription.localizedCaseInsensitiveContains("not associated"):
            code = "not-associated"
        default:
            code = "failed"
        }
        call.reject("\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)", code, error)
    }
}
