import Foundation
import Testing
@testable import FilmStudioKit

private let archiveStatusJSON = #"{"connected":true,"provider":"google-drive","rootFolder":"Film Studio","folderUrl":"https://drive.google.com/drive/folders/private123","policy":{"enabled":true,"uploadDelayHours":24,"removeLocalAfterHours":null},"busy":false,"stats":{"projects":2,"videos":3,"verifiedBytes":12345,"localBytesFreed":0,"pending":0},"lastRunAt":null,"lastError":null}"#

@Suite struct DriveArchiveTests {
    @Test func keepAlwaysSendsExplicitNull() throws {
        let policy = DriveArchivePolicy(enabled: true, uploadDelayHours: 24, removeLocalAfterHours: nil)
        let data = try JSONEncoder().encode(policy.requestBody)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?["removeLocalAfterHours"] is NSNull)
        let status = try JSONDecoder().decode(DriveArchiveStatus.self, from: Data(archiveStatusJSON.utf8))
        #expect(status.policy == policy)
        #expect(status.folderURL?.host == "drive.google.com")
    }

    @Test func rejectUntrustedFolderLinks() {
        for value in ["https://drive.google.com.evil.example/drive/folders/x", "javascript:alert(1)", "http://drive.google.com/drive/folders/x", "https://user:pass@drive.google.com/drive/folders/x", "https://drive.google.com:8443/drive/folders/x", "https://drive.google.com/open?id=x"] {
            #expect(DriveArchiveStatus.privateFolderURL(value) == nil)
        }
    }
}

extension NetworkTests {
@Suite struct DriveArchiveAPITests {
    private func client() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return APIClient(baseURL: URL(string: "https://films.heil.haus")!, session: URLSession(configuration: config), token: { "studio-session" })
    }

    @Test func settingsUseAuthenticatedPatchAndPreserveNull() async throws {
        StubProtocol.reset { _, _ in .init(body: archiveStatusJSON) }
        _ = try await client().updateDriveArchivePolicy(.init(enabled: true, uploadDelayHours: 24, removeLocalAfterHours: nil))
        let request = try #require(StubProtocol.last)
        #expect(request.0.httpMethod == "PATCH")
        #expect(request.0.url?.path == "/engine/api/archive/settings")
        #expect(request.0.value(forHTTPHeaderField: "Authorization") == "Bearer studio-session")
        let json = try JSONSerialization.jsonObject(with: request.1) as? [String: Any]
        #expect(json?["removeLocalAfterHours"] is NSNull)
    }

    @Test func missingRouteAndFailedRunAreNotSuccess() async {
        StubProtocol.reset { _, _ in .init(status: 404, body: #"{"error":"no such route"}"#) }
        do { _ = try await client().driveArchiveStatus(); Issue.record("Missing route must not become a connected status") }
        catch let error as APIError { #expect(error.isMissingRoute) }
        catch { Issue.record("Unexpected \(error)") }
        StubProtocol.reset { _, _ in .init(status: 503, body: #"{"error":"Google Drive is unavailable"}"#) }
        await #expect(throws: APIError.server(status: 503, message: "Google Drive is unavailable")) { try await client().runDriveArchive() }
    }
}
}
