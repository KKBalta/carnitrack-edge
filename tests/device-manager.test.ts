/**
 * Comprehensive tests for Device Manager
 * 
 * Tests device registration, heartbeat tracking, status management,
 * and event handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDeviceManager, getDeviceManager } from "../src/devices/device-manager.ts";
import { initDatabase, closeDatabase, getDatabase, nowISO } from "../src/storage/database.ts";

describe("Device Manager", () => {
  beforeEach(() => {
    initDatabase();
    initDeviceManager();
    
    const db = getDatabase();
    // Clean up test data (delete in order to respect foreign keys)
    db.prepare(`DELETE FROM events`).run();
    db.prepare(`DELETE FROM offline_batches`).run();
    db.prepare(`DELETE FROM active_sessions_cache`).run();
    db.prepare(`DELETE FROM devices`).run();
  });

  afterEach(() => {
    // DeviceManager doesn't have a destroy function - it's a singleton
    closeDatabase();
  });

  describe("initialize", () => {
    it("should load devices from database on initialization", () => {
      const db = getDatabase();
      const manager = getDeviceManager();
      
      // Insert test devices
      db.prepare(`
        INSERT INTO devices (device_id, status, tcp_connected, display_name)
        VALUES ('SCALE-01', 'online', 0, 'Test Scale 1'),
               ('SCALE-02', 'online', 0, 'Test Scale 2')
      `).run();
      
      manager.initialize();
      
      const device1 = manager.getDevice("SCALE-01");
      const device2 = manager.getDevice("SCALE-02");
      
      expect(device1).not.toBeNull();
      expect(device2).not.toBeNull();
      expect(device1?.displayName).toBe("Test Scale 1");
      expect(device2?.displayName).toBe("Test Scale 2");
    });

    it("should set site ID for global device ID generation", () => {
      const manager = getDeviceManager();
      manager.initialize("SITE-001");
      manager.setSiteId("SITE-001");
      
      expect(manager.getSiteId()).toBe("SITE-001");
    });
  });

  describe("registerDevice", () => {
    it("should register a new device", () => {
      const manager = getDeviceManager();
      manager.initialize("SITE-001");
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
        deviceType: "disassembly",
      });
      
      expect(device).not.toBeNull();
      expect(device.deviceId).toBe("SCALE-01");
      expect(device.globalDeviceId).toBe("SITE-001-SCALE-01");
      expect(device.status).toBe("online");
      expect(device.tcpConnected).toBe(true);
      expect(device.sourceIp).toBe("192.168.1.100");
      expect(device.socketId).toBe("sock-123");
      
      // Verify persisted in database
      const db = getDatabase();
      const stored = db.prepare(`SELECT * FROM devices WHERE device_id = ?`).get("SCALE-01") as any;
      expect(stored).not.toBeNull();
      expect(stored.status).toBe("online");
      expect(stored.tcp_connected).toBe(1);
    });

    it("should handle device reconnection", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      // Register device first time
      const device1 = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      // Simulate disconnect
      manager.handleDisconnect("sock-123", "test disconnect");
      
      // Reconnect with new socket
      const device2 = manager.registerDevice({
        socketId: "sock-456",
        scaleNumber: "01",
        sourceIp: "192.168.1.101",
      });
      
      expect(device2.deviceId).toBe(device1.deviceId);
      expect(device2.socketId).toBe("sock-456");
      expect(device2.sourceIp).toBe("192.168.1.101");
      expect(device2.tcpConnected).toBe(true);
    });

    it("should emit registered event for new device", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      let eventReceived = false;
      let receivedDevice: any = null;
      
      manager.on("registered", (device) => {
        eventReceived = true;
        receivedDevice = device;
      });
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      expect(eventReceived).toBe(true);
      expect(receivedDevice.deviceId).toBe("SCALE-01");
    });
  });

  describe("updateHeartbeat", () => {
    it("should update device heartbeat timestamp", async () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      const initialHeartbeatCount = device.heartbeatCount;
      const initialHeartbeatAt = device.lastHeartbeatAt;
      
      // Wait a bit to ensure time difference
      await Bun.sleep(10);
      
      const updated = manager.updateHeartbeat("sock-123");
      
      expect(updated).not.toBeNull();
      expect(updated?.heartbeatCount).toBe(initialHeartbeatCount + 1);
      expect(updated?.lastHeartbeatAt?.getTime()).toBeGreaterThan(initialHeartbeatAt?.getTime() || 0);
    });

    it("should restore stale device to online on heartbeat", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      // Manually set to stale
      const db = getDatabase();
      db.prepare(`UPDATE devices SET status = 'stale' WHERE device_id = ?`).run(device.deviceId);
      device.status = "stale";
      
      const updated = manager.updateHeartbeat("sock-123");
      
      expect(updated?.status).toBe("online");
    });

    it("should return null for unknown socket", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const result = manager.updateHeartbeat("unknown-socket");
      expect(result).toBeNull();
    });
  });

  describe("updateOnEvent", () => {
    it("should update device event count and timestamp", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      const initialEventCount = device.eventCount;
      
      const updated = manager.updateOnEvent("sock-123");
      
      expect(updated).not.toBeNull();
      expect(updated?.eventCount).toBe(initialEventCount + 1);
      expect(updated?.lastEventAt).not.toBeNull();
      expect(updated?.status).toBe("online");
    });

    it("should change idle device to online on event", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      // Set device to idle
      device.status = "idle";
      const db = getDatabase();
      db.prepare(`UPDATE devices SET status = 'idle' WHERE device_id = ?`).run(device.deviceId);
      
      const updated = manager.updateOnEvent("sock-123");
      
      expect(updated?.status).toBe("online");
    });
  });

  describe("handleDisconnect", () => {
    it("should mark device as disconnected", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      manager.handleDisconnect("sock-123", "test disconnect");
      
      const updated = manager.getDevice("SCALE-01");
      expect(updated?.tcpConnected).toBe(false);
      expect(updated?.status).toBe("disconnected");
      expect(updated?.socketId).toBeNull();
    });

    it("should emit disconnected event", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      let eventReceived = false;
      manager.on("disconnected", () => {
        eventReceived = true;
      });
      
      manager.handleDisconnect("sock-123", "test disconnect");
      
      expect(eventReceived).toBe(true);
    });
  });

  describe("getDevice", () => {
    it("should retrieve device by device ID", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      const device = manager.getDevice("SCALE-01");
      
      expect(device).not.toBeNull();
      expect(device?.deviceId).toBe("SCALE-01");
    });

    it("should return null for non-existent device", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.getDevice("SCALE-99");
      expect(device).toBeNull();
    });
  });

  describe("getDeviceBySocket", () => {
    it("should retrieve device by socket ID", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      const device = manager.getDeviceBySocket("sock-123");
      
      expect(device).not.toBeNull();
      expect(device?.deviceId).toBe("SCALE-01");
    });

    it("should return null for unknown socket", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      const device = manager.getDeviceBySocket("unknown-socket");
      expect(device).toBeNull();
    });
  });

  describe("getAllDevices", () => {
    it("should return all registered devices", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      manager.registerDevice({
        socketId: "sock-456",
        scaleNumber: "02",
        sourceIp: "192.168.1.101",
      });
      
      const devices = manager.getAllDevices();
      
      expect(devices.length).toBe(2);
      expect(devices.some(d => d.deviceId === "SCALE-01")).toBe(true);
      expect(devices.some(d => d.deviceId === "SCALE-02")).toBe(true);
    });
  });

  describe("updateDeviceInfo", () => {
    it("should update device display name and location", () => {
      const manager = getDeviceManager();
      manager.initialize();
      
      manager.registerDevice({
        socketId: "sock-123",
        scaleNumber: "01",
        sourceIp: "192.168.1.100",
      });
      
      manager.updateDeviceInfo("SCALE-01", {
        displayName: "Kesimhane Terazi 1",
        location: "Kesimhane A Bölümü",
      });
      
      const device = manager.getDevice("SCALE-01");
      expect(device?.displayName).toBe("Kesimhane Terazi 1");
      expect(device?.location).toBe("Kesimhane A Bölümü");
      
      // Verify persisted
      const db = getDatabase();
      const stored = db.prepare(`SELECT display_name, location FROM devices WHERE device_id = ?`).get("SCALE-01") as any;
      expect(stored.display_name).toBe("Kesimhane Terazi 1");
      expect(stored.location).toBe("Kesimhane A Bölümü");
    });
  });
});
