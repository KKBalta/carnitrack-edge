import { describe, it, expect } from "bun:test";
import { ipv4ToList, suggestSubnetFromIp } from "../src/printers/discovery.ts";

describe("printer discovery parse", () => {
  it("suggestSubnetFromIp builds /24", () => {
    expect(suggestSubnetFromIp("192.168.1.50")).toBe("192.168.1.0/24");
    expect(suggestSubnetFromIp("10.0.0.2")).toBe("10.0.0.0/24");
  });

  it("ipv4ToList expands /24 with .0 host", () => {
    const hosts = ipv4ToList("192.168.2.0/24");
    expect(hosts.length).toBe(254);
    expect(hosts[0]).toBe("192.168.2.1");
    expect(hosts[253]).toBe("192.168.2.254");
  });

  it("ipv4ToList /24 always sweeps full subnet (not only host octet)", () => {
    const hosts = ipv4ToList("192.168.2.1/24");
    expect(hosts.length).toBe(254);
    expect(hosts[0]).toBe("192.168.2.1");
    expect(hosts[1]).toBe("192.168.2.2");
  });

  it("ipv4ToList single host when last octet non-zero", () => {
    expect(ipv4ToList("192.168.5.12")).toEqual(["192.168.5.12"]);
  });

  it("ipv4ToList three-octet prefix", () => {
    const h = ipv4ToList("10.10.10");
    expect(h.length).toBe(254);
    expect(h[0]).toBe("10.10.10.1");
  });
});
