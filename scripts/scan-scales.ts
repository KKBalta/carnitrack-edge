#!/usr/bin/env bun
/**
 * Network Scale Scanner
 * 
 * Scans the local network for scales listening on port 8899.
 * Useful when DHCP assigns new IPs to scales.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK UTILITIES
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
        // Look for inet address (not loopback or link-local)
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
 * Get network CIDR from IP
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
        // Calculate CIDR bits
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
 * Check if a device has a web interface
 */
async function checkWebInterface(ip: string): Promise<{ port: number; type: string } | null> {
  const commonPorts = [
    { port: 80, type: "HTTP" },
    { port: 8080, type: "HTTP-8080" },
    { port: 8000, type: "HTTP-8000" },
  ];
  
  for (const { port, type } of commonPorts) {
    try {
      const response = await fetch(`http://${ip}:${port}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok || response.status < 500) {
        return { port, type };
      }
    } catch (error) {
      // Continue to next port
    }
  }
  
  return null;
}

/**
 * Scan network for devices on TCP port
 */
async function scanNetworkForPort(cidr: string, port: number): Promise<Array<{ ip: string; latency: number; webInterface?: { port: number; type: string } }>> {
  const found: Array<{ ip: string; latency: number; webInterface?: { port: number; type: string } }> = [];
  
  const [network, prefix] = cidr.split("/");
  const prefixLength = parseInt(prefix || "24", 10);
  const networkParts = network.split(".").map(Number);
  
  const hostBits = 32 - prefixLength;
  const hostCount = Math.min(Math.pow(2, hostBits) - 2, 254); // Exclude network and broadcast
  
  console.log(`\n🔍 Scanning ${cidr} for devices listening on port ${port}...`);
  console.log(`   Checking ${hostCount} IP addresses...\n`);
  
  let checked = 0;
  const batchSize = 20;
  const promises: Promise<void>[] = [];
  
  for (let i = 1; i <= hostCount; i++) {
    const ip = `${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`;
    
    const promise = (async () => {
      try {
        const start = Date.now();
        const socket = await Bun.connect({
          hostname: ip,
          port: port,
          connectTimeout: 500, // 500ms timeout for faster scanning
        });
        
        const latency = Date.now() - start;
        socket.end();
        
        // Check for web interface
        const webInterface = await checkWebInterface(ip);
        
        found.push({ ip, latency, webInterface: webInterface || undefined });
        console.log(`  ✅ Found device: ${ip}:${port} (${latency}ms)`);
        if (webInterface) {
          console.log(`     🌐 Web interface: http://${ip}:${webInterface.port} (${webInterface.type})`);
        }
      } catch (error) {
        // Connection failed, continue
      }
      
      checked++;
      if (checked % batchSize === 0) {
        process.stdout.write(`  Progress: ${checked}/${hostCount} (${Math.round((checked / hostCount) * 100)}%)\r`);
      }
    })();
    
    promises.push(promise);
    
    // Process in batches to avoid overwhelming the network
    if (promises.length >= batchSize) {
      await Promise.all(promises);
      promises.length = 0;
    }
  }
  
  // Process remaining promises
  if (promises.length > 0) {
    await Promise.all(promises);
  }
  
  console.log(`\n`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         Network Scale Scanner                                ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("\n");
  
  const port = 8899;
  const localIP = getLocalIP();
  
  if (!localIP) {
    console.error("❌ Could not determine local IP address");
    console.log("\n💡 Please ensure you're connected to WiFi and try again.");
    process.exit(1);
  }
  
  console.log(`📍 Your Local IP: ${localIP}`);
  console.log(`📡 Scanning for devices on port: ${port}\n`);
  
  const networkCIDR = getNetworkCIDR(localIP);
  
  if (!networkCIDR) {
    console.error("❌ Could not determine network CIDR");
    console.log("\n💡 Please specify network manually:");
    console.log(`   bun scripts/scan-scales.ts --network 192.168.1.0/24`);
    process.exit(1);
  }
  
  console.log(`🌐 Network: ${networkCIDR}\n`);
  
  const found = await scanNetworkForPort(networkCIDR, port);
  
  console.log("═".repeat(63));
  console.log("📋 SCAN RESULTS");
  console.log("═".repeat(63));
  
  if (found.length > 0) {
    console.log(`\n✅ Found ${found.length} device(s) listening on port ${port}:\n`);
    found.forEach((device, index) => {
      console.log(`   ${index + 1}. ${device.ip}:${port} (latency: ${device.latency}ms)`);
      if (device.webInterface) {
        console.log(`      🌐 Web Interface: http://${device.ip}:${device.webInterface.port}`);
      }
    });
    console.log("\n💡 These devices have port 8899 open - they could be scale WiFi modules.");
    console.log("   Access their web interfaces to configure them.");
    console.log(`   After configuration, set them to connect to: ${localIP}:${port}`);
  } else {
    console.log(`\n⚠️  No devices found listening on port ${port}`);
    console.log("\n💡 Possible reasons:");
    console.log("   • Scales are not powered on");
    console.log("   • Scales are not connected to WiFi");
    console.log("   • Scales are on a different network");
    console.log("   • Firewall blocking port", port);
    console.log("   • WiFi modules might use a different port");
    console.log("\n💡 Next steps:");
    console.log("   • Check scale power and WiFi connection");
    console.log("   • Check router DHCP client list for scale MAC addresses");
    console.log("   • Try scanning common web interface ports (80, 8080)");
  }
  
  console.log("\n");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
