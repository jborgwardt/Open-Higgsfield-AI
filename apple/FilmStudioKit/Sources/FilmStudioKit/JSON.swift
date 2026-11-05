import Foundation

/// A coding key from any string, so models can decode leniently without a CodingKeys enum per type.
public struct AnyKey: CodingKey, Hashable, Sendable, ExpressibleByStringLiteral {
    public var stringValue: String
    public var intValue: Int?
    public init(_ s: String) { stringValue = s }
    public init(stringLiteral s: String) { stringValue = s }
    public init?(stringValue: String) { self.stringValue = stringValue }
    public init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

/// Any JSON value. Used for server-defined data (tool defaults, config defaults, patches).
public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n):
            if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }
    public var double: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s.trimmingCharacters(in: .whitespaces))
        case .bool(let b): return b ? 1 : 0
        default: return nil
        }
    }
    public var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return ["true", "1", "yes", "on"].contains(s.lowercased()) ? true : (["false", "0", "no", "off", ""].contains(s.lowercased()) ? false : nil)
        default: return nil
        }
    }
    /// JavaScript-style truthiness (for flags like coverage `have` values that may be bools or counts).
    public var isTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return !s.isEmpty && s != "false" && s != "0"
        case .array(let a): return !a.isEmpty
        case .object: return true
        }
    }
    public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public subscript(key: String) -> JSONValue? { object?[key] }
    public var isNull: Bool { self == .null }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral v: String) { self = .string(v) }
    public init(integerLiteral v: Int) { self = .number(Double(v)) }
    public init(floatLiteral v: Double) { self = .number(v) }
    public init(booleanLiteral v: Bool) { self = .bool(v) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    public init(nilLiteral: ()) { self = .null }
}

public extension JSONValue {
    init(_ s: String?) { self = s.map { .string($0) } ?? .null }
    init(_ d: Double?) { self = d.map { .number($0) } ?? .null }
    init(_ i: Int?) { self = i.map { .number(Double($0)) } ?? .null }
    init(_ b: Bool) { self = .bool(b) }
    init(_ list: [String]) { self = .array(list.map { .string($0) }) }
}

/// Lenient accessors: a wrong type or a missing key yields nil (or the default), never a decoding error.
public extension KeyedDecodingContainer where Key == AnyKey {
    func value<T: Decodable>(_ key: String, as _: T.Type = T.self) -> T? {
        (try? decodeIfPresent(T.self, forKey: AnyKey(key))) ?? nil
    }
    func json(_ key: String) -> JSONValue? {
        guard let v = value(key, as: JSONValue.self), !v.isNull else { return nil }
        return v
    }
    func string(_ key: String) -> String? { json(key)?.string }
    func string(_ key: String, default d: String) -> String { string(key) ?? d }
    func double(_ key: String) -> Double? { json(key)?.double }
    func int(_ key: String) -> Int? { double(key).flatMap { $0.isFinite ? Int($0) : nil } }
    func bool(_ key: String) -> Bool? { json(key)?.bool }
    func bool(_ key: String, default d: Bool) -> Bool { bool(key) ?? d }
    /// Decodes an array, skipping elements that fail to decode instead of failing the whole response.
    func list<T: Decodable>(_ key: String, of _: T.Type = T.self) -> [T] {
        (value(key, as: [Lossy<T>].self) ?? []).compactMap(\.value)
    }
    func strings(_ key: String) -> [String] { (json(key)?.array ?? []).compactMap(\.string) }
    func doubles(_ key: String) -> [Double] { (json(key)?.array ?? []).compactMap(\.double) }
}

/// Wraps one element of a lossy array.
public struct Lossy<T: Decodable>: Decodable {
    public let value: T?
    public init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// A lossy top-level array.
public struct LossyList<T: Decodable>: Decodable {
    public let items: [T]
    public init(from decoder: Decoder) throws {
        items = ((try? [Lossy<T>](from: decoder)) ?? []).compactMap(\.value)
    }
}

/// A string-backed open enum: unknown server values are preserved instead of failing to decode.
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
    init(rawValue: String)
}
public extension OpenEnum {
    init(from decoder: Decoder) throws { self.init(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") }
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
}

extension String {
    /// Percent-encodes a single path segment (ids from the server are opaque).
    public var pathSegment: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? self
    }
}
