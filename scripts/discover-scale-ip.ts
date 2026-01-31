#!/usr/bin/env bun
/**
 * Discover Scale IP Address
 * 
 * Finds the IP address of a WiFi scale that just connected to a new network.
 * Uses multiple methods to locate the scale.
 */

import { config } from "../src/config.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get local IP address
 */
function getLocalIP(): string | null {
  try {
    const result = Bun.spawnSync(["ifconfig"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (result.success) {
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");
      
      for (const line of lines) {
        // Look for inet address (not loopback)
        const match = line.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        if (match) {
          const ip = match[1];
          if (!ip.startsWith("127.") && !ip.startsWith("169.254.")) {
            return ip;
          }
        }
      }
    }
  } catch (error) {
    console.error("Failed to get local IP:", error);
  }
  
  return null;
}

/**
 * Get network CIDR from IP and interface
 */
function getNetworkCIDR(ip: string): string | null {
  try {
    const result = Bun.spawnSync(["ifconfig"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (result.success) {
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");
      
      let currentIP: string | null = null;
      let netmask: string | null = null;
      
      for (const line of lines) {
        const ipMatch = line.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        if (ipMatch && ipMatch[1] === ip) {
          currentIP = ipMatch[1];
        }
        
        if (currentIP === ip) {
          const netmaskMatch = line.match(/netmask (0x[a-f0-9]+|\d+\.\d+\.\d+\.\d+)/);
          if (netmaskMatch) {
            netmask = netmaskMatch[1];
            break;
          }
        }
      }
      
      if (netmask && currentIP) {
        // Calculate CIDR
        let cidrBits = 24; // Default
        
        if (netmask.startsWith("0x")) {
          const hex = parseInt(netmask, 16);
          cidrBits = (hex >>> 0).toString(2).split("1").length - 1;
        } else {
          const parts = netmask.split(".").map(Number);
          const binary = parts.map(p => p.toString(2).padStart(8, "0")).join("");
          cidrBits = binary.split("1").length - 1;
        }
        
        const ipParts = currentIP.split(".").map(Number);
        return `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.0/${cidrBits}`;
      }
    }
  } catch (error) {
    console.error("Failed to get network CIDR:", error);
  }
  
  return null;
}

/**
 * Check Edge server for connected devices
 */
async function checkEdgeServerDevices(): Promise<Array<{ deviceId: string; ip: string; status: string }>> {
  const devices: Array<{ deviceId: string; ip: string; status: string }> = [];
  
  try {
    const httpPort = config.http.port;
    const httpHost = config.http.host === "0.0.0.0" ? "localhost" : config.http.host;
    
    const response = await fetch(`http://${httpHost}:${httpPort}/api/devices`);
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.data) {
        for (const device of data.data) {
          if (device.sourceIp) {
            devices.push({
              deviceId: device.deviceId,
              ip: device.sourceIp,
              status: device.status,
            });
          }
        }
      }
    }
  } catch (error) {
    // Edge server might not be running, that's okay
  }
  
  return devices;
}

/**
 * Check active TCP connections
 */
function checkTCPConnections(port: number): Array<{ ip: string; port: number }> {
  const connections: Array<{ ip: string; port: number }> = [];
  
  try {
    // Try netstat
    const netstatResult = Bun.spawnSync(["netstat", "-an"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (netstatResult.success) {
      const output = new TextDecoder().decode(netstatResult.stdout);
      const lines = output.split("\n");
      
      for (const line of lines) {
        // Look for ESTABLISHED connections on our port
        if (line.includes(`.${port}`) && line.includes("ESTABLISHED")) {
          // Extract IP address
          const match = line.match(/(\d+\.\d+\.\d+\.\d+)\.\d+/);
          if (match) {
            const ip = match[1];
            if (!ip.startsWith("127.")) {
              connections.push({ ip, port });
            }
          }
        }
      }
    }
  } catch (error) {
    // netstat might not be available
  }
  
  // Try lsof (macOS/Linux)
  try {
    const lsofResult = Bun.spawnSync(["lsof", "-i", `:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (lsofResult.success) {
      const output = new TextDecoder().decode(lsofResult.stdout);
      const lines = output.split("\n");
      
      for (const line of lines) {
        // Look for ESTABLISHED connections
        if (line.includes("ESTABLISHED")) {
          const match = line.match(/(\d+\.\d+\.\d+\.\d+):\d+/);
          if (match) {
            const ip = match[1];
            if (!ip.startsWith("127.")) {
              connections.push({ ip, port });
            }
          }
        }
      }
    }
  } catch (error) {
    // lsof might not be available
  }
  
  return connections;
}

/**
 * Scan network for devices on TCP port
 */
async function scanNetworkForPort(cidr: string, port: number): Promise<Array<{ ip: string; latency: number }>> {
  const found: Array<{ ip: string; latency: number }> = [];
  
  console.log(`\n🔍 Scanning ${cidr} for devices on port ${port}...`);
  console.log(`   This will test each IP address...\n`);
  
  const [network, prefix] = cidr.split("/");
  const prefixLength = parseInt(prefix || "24", 10);
  const networkParts = network.split(".").map(Number);
  
  const hostBits = 32 - prefixLength;
  const hostCount = Math.min(Math.pow(2, hostBits) - 2, 254);
  
  let checked = 0;
  const batchSize = 20;
  
  for (let i = 1; i <= hostCount; i++) {
    const ip = `${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`;
    
    try {
      const start = Date.now();
      const socket = await Bun.connect({
        hostname: ip,
        port: port,
        connectTimeout: 500, // 500ms timeout for faster scanning
      });
      
      const latency = Date.now() - start;
      socket.end();
      
      found.push({ ip, latency });
      console.log(`  ✅ Found device: ${ip}:${port} (${latency}ms)`);
    } catch (error) {
      // Connection failed, continue
    }
    
    checked++;
    if (checked % batchSize === 0) {
      process.stdout.write(`  Progress: ${checked}/${hostCount}\r`);
    }
  }
  
  console.log(`\n`);
  return found;
}

/**
 * Check router ARP table (if accessible)
 */
function checkARPTable(): Array<string> {
  const ips: string[] = [];
  
  try {
    const result = Bun.spawnSync(["arp", "-a"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (result.success) {
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");
      
      for (const line of lines) {
        const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
        if (match) {
          const ip = match[1];
          if (!ip.startsWith("127.") && !ip.startsWith("224.") && !ip.startsWith("255.")) {
            ips.push(ip);
          }
        }
      }
    }
  } catch (error) {
    // ARP might not be available
  }
  
  return ips;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         Scale IP Discovery Tool                             ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("\n🔍 Discovering scale IP address...\n");
  
  const tcpPort = config.tcp.port;
  const localIP = getLocalIP();
  
  if (!localIP) {
    console.error("❌ Could not determine local IP address");
    console.log("\n💡 Please ensure you're connected to WiFi and try again.");
    process.exit(1);
  }
  
  console.log(`📍 Your Edge Server IP: ${localIP}`);
  console.log(`📡 TCP Port: ${tcpPort}\n`);
  
  // Method 1: Check Edge server for registered devices
  console.log("Method 1: Checking Edge server for connected devices...");
  const edgeDevices = await checkEdgeServerDevices();
  if (edgeDevices.length > 0) {
    console.log(`\n✅ Found ${edgeDevices.length} device(s) in Edge server:\n`);
    edgeDevices.forEach(device => {
      console.log(`   Device: ${device.deviceId}`);
      console.log(`   IP: ${device.ip}`);
      console.log(`   Status: ${device.status}`);
      console.log("");
    });
  } else {
    console.log("   ⚠️  No devices currently connected to Edge server\n");
  }
  
  // Method 2: Check active TCP connections
  console.log("Method 2: Checking active TCP connections...");
  const tcpConnections = checkTCPConnections(tcpPort);
  if (tcpConnections.length > 0) {
    console.log(`\n✅ Found ${tcpConnections.length} active TCP connection(s):\n`);
    tcpConnections.forEach(conn => {
      console.log(`   IP: ${conn.ip}:${conn.port}`);
    });
    console.log("");
  } else {
    console.log("   ⚠️  No active TCP connections found\n");
  }
  
  // Method 3: Check ARP table
  console.log("Method 3: Checking ARP table...");
  const arpIPs = checkARPTable();
  if (arpIPs.length > 0) {
    console.log(`\n✅ Found ${arpIPs.length} device(s) in ARP table`);
    console.log(`   (Note: Scale may not appear here until it connects)\n`);
  } else {
    console.log("   ⚠️  ARP table empty or not accessible\n");
  }
  
  // Method 4: Network scan (if needed)
  if (edgeDevices.length === 0 && tcpConnections.length === 0) {
    console.log("Method 4: Scanning network for scale devices...");
    const networkCIDR = getNetworkCIDR(localIP);
    
    if (networkCIDR) {
      console.log(`   Network: ${networkCIDR}`);
      const found = await scanNetworkForPort(networkCIDR, tcpPort);
      
      if (found.length > 0) {
        console.log(`\n✅ Found ${found.length} device(s) listening on port ${tcpPort}:\n`);
        found.forEach(device => {
          console.log(`   IP: ${device.ip} (latency: ${device.latency}ms)`);
        });
        console.log("");
      } else {
        console.log(`\n⚠️  No devices found listening on port ${tcpPort}`);
        console.log(`\n💡 The scale may not be connected yet, or it's on a different network.`);
      }
    } else {
      console.log("   ⚠️  Could not determine network CIDR for scanning");
    }
  }
  
  // Summary
  console.log("\n" + "═".repeat(63));
  console.log("📋 SUMMARY");
  console.log("═".repeat(63));
  
  if (edgeDevices.length > 0) {
    console.log("\n✅ Scale found via Edge server:");
    edgeDevices.forEach(device => {
      console.log(`   • ${device.deviceId} at ${device.ip} (${device.status})`);
    });
  } else if (tcpConnections.length > 0) {
    console.log("\n✅ Potential scale connection found:");
    tcpConnections.forEach(conn => {
      console.log(`   • ${conn.ip}:${conn.port}`);
    });
    console.log("\n💡 Check Edge server logs to confirm this is your scale.");
  } else {
    console.log("\n⚠️  Scale not found. Possible reasons:");
    console.log("   1. Scale is not powered on");
    console.log("   2. Scale WiFi is not connected");
    console.log("   3. Scale WiFi module not configured correctly");
    console.log("   4. Scale is on a different network");
    console.log("   5. Firewall blocking port", tcpPort);
    console.log("\n💡 Next steps:");
    console.log("   • Check scale power and WiFi connection");
    console.log("   • Verify scale WiFi config (Server IP:", localIP + ", Port:", tcpPort + ")");
    console.log("   • Check router DHCP client list");
    console.log("   • Monitor Edge server: tail -f logs/*.log");
  }
  
  console.log("\n");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
