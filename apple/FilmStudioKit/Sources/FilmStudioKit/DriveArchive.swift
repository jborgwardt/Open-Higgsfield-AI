import Foundation

public struct DriveArchivePolicy: Decodable, Equatable, Sendable {
    public var enabled: Bool
    public var uploadDelayHours: Int
    public var removeLocalAfterHours: Int?

    public init(enabled: Bool = false, uploadDelayHours: Int = 0, removeLocalAfterHours: Int? = nil) {
        self.enabled = enabled
        self.uploadDelayHours = uploadDelayHours
        self.removeLocalAfterHours = removeLocalAfterHours
    }

    /// An explicit null means keep server copies; omitting the key would leave the old policy in place.
    public var requestBody: [String: JSONValue] {
        ["enabled": .bool(enabled), "uploadDelayHours": .number(Double(uploadDelayHours)),
         "removeLocalAfterHours": removeLocalAfterHours.map { .number(Double($0)) } ?? .null]
    }
}

public struct DriveArchiveStatus: Decodable, Sendable {
    public let connected: Bool
    public let provider: String?
    public let rootFolder: String
    public let folderUrl: String?
    public let policy: DriveArchivePolicy
    public let stats: [String: JSONValue]?
    public let lastError: String?
    public let busy: Bool?
    public let lastRunAt: String?

    public var folderURL: URL? { Self.privateFolderURL(folderUrl) }

    public static func privateFolderURL(_ value: String?) -> URL? {
        guard let value, let url = URLComponents(string: value),
              url.scheme?.lowercased() == "https", url.host?.lowercased() == "drive.google.com",
              url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              url.path.hasPrefix("/drive/folders/") else { return nil }
        return url.url
    }
}

public extension APIClient {
    func driveArchiveStatus() async throws -> DriveArchiveStatus {
        let path = "/archive/status"
        var request = makeRequest("GET", path)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try decode(DriveArchiveStatus.self, from: await perform(request, route: path), route: path)
    }

    func updateDriveArchivePolicy(_ policy: DriveArchivePolicy) async throws -> DriveArchiveStatus {
        try await send("PATCH", "/archive/settings", json: policy.requestBody)
    }

    func runDriveArchive() async throws {
        let _: JSONValue = try await send("POST", "/archive/run")
    }
}

public struct ProjectDriveArchive: Decodable, Sendable {
    public let id: String
    public let status: String
    public let title: String?
    public let folderUrl: String?
    public let error: String?
    public let verifiedAt: String?
    public let localOffloaded: Bool
    public var folderURL: URL? { DriveArchiveStatus.privateFolderURL(folderUrl) }
    public var label: String {
        switch status {
        case "verified": localOffloaded ? "Stored in Google Drive" : "Backup verified"
        case "uploading": "Backing up…"
        case "error": "Backup needs attention"
        case "not_archived": "Not backed up yet"
        default: "Backup status unavailable"
        }
    }
}

public extension APIClient {
    func projectDriveArchive(_ id: String) async throws -> ProjectDriveArchive {
        try await get("/productions/\(id)/archive")
    }

    func backUpProjectToDrive(_ id: String) async throws -> ProjectDriveArchive {
        try await send("POST", "/productions/\(id)/archive")
    }

    func restoreProjectFromDrive(_ id: String) async throws {
        let _: JSONValue = try await send("POST", "/productions/\(id)/restore")
    }
}
