#!/usr/bin/env bun
/**
 * WiFi Module Discovery Tool
 * 
 * Finds WiFi modules on the network by scanning for web interfaces.
 * These modules typically have web interfaces on ports 80, 8080, etc.
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
        let cidrBits = 24;
        
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
 * Check if a device responds to HTTP on a port
 */
async function checkHTTPPort(ip: string, port: number, timeout: number = 2000): Promise<{ success: boolean; status?: number; title?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(`http://${ip}:${port}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok || response.status < 500) {
      // Try to get page title
      let title = '';
      try {
        const text = await response.text();
        const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      } catch (e) {
        // Ignore parsing errors
      }
      
      return { success: true, status: response.status, title };
    }
  } catch (error) {
    // Connection failed or timeout
  }
  
  return { success: false };
}

/**
 * Check ARP table for devices
 */
function getARPDevices(): Array<{ ip: string; mac?: string }> {
  const devices: Array<{ ip: string; mac?: string }> = [];
  
  try {
    const result = Bun.spawnSync(["arp", "-a"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (result.success) {
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");
      
      for (const line of lines) {
        const ipMatch = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
        const macMatch = line.match(/([0-9a-f]{1,2}[:-][0-9a-f]{1,2}[:-][0-9a-f]{1,2}[:-][0-9a-f]{1,2}[:-][0-9a-f]{1,2}[:-][0-9a-f]{1,2})/i);
        
        if (ipMatch) {
          const ip = ipMatch[1];
          if (!ip.startsWith("127.") && !ip.startsWith("224.") && !ip.startsWith("255.")) {
            devices.push({
              ip,
              mac: macMatch ? macMatch[1] : undefined,
            });
          }
        }
      }
    }
  } catch (error) {
    // ARP might not be available
  }
  
  return devices;
}

/**
 * Scan network for HTTP web interfaces
 */
async function scanForWebInterfaces(cidr: string, ports: number[]): Promise<Array<{ ip: string; port: number; status: number; title?: string }>> {
  const found: Array<{ ip: string; port: number; status: number; title?: string }> = [];
  
  const [network, prefix] = cidr.split("/");
  const prefixLength = parseInt(prefix || "24", 10);
  const networkParts = network.split(".").map(Number);
  
  const hostBits = 32 - prefixLength;
  const hostCount = Math.min(Math.pow(2, hostBits) - 2, 254);
  
  console.log(`\n🔍 Scanning ${cidr} for web interfaces...`);
  console.log(`   Ports: ${ports.join(", ")}`);
  console.log(`   Checking ${hostCount} IP addresses...\n`);
  
  // First, get ARP table to prioritize known devices
  const arpDevices = getARPDevices();
  const arpIPs = new Set(arpDevices.map(d => d.ip));
  
  console.log(`📋 Found ${arpDevices.length} devices in ARP table - checking those first...\n`);
  
  // Check ARP devices first (faster)
  for (const device of arpDevices) {
    for (const port of ports) {
      const result = await checkHTTPPort(device.ip, port, 1500);
      if (result.success && result.status) {
        found.push({
          ip: device.ip,
          port,
          status: result.status,
          title: result.title,
        });
        console.log(`  ✅ Found web interface: http://${device.ip}:${port} (${result.status})${result.title ? ` - ${result.title}` : ''}`);
      }
    }
  }
  
  // Then scan remaining IPs
  let checked = 0;
  const batchSize = 10;
  
  for (let i = 1; i <= hostCount; i++) {
    const ip = `${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`;
    
    // Skip if already checked via ARP
    if (arpIPs.has(ip)) continue;
    
    // Check all ports for this IP
    for (const port of ports) {
      const result = await checkHTTPPort(ip, port, 1000);
      if (result.success && result.status) {
        found.push({
          ip,
          port,
          status: result.status,
          title: result.title,
        });
        console.log(`  ✅ Found web interface: http://${ip}:${port} (${result.status})${result.title ? ` - ${result.title}` : ''}`);
      }
    }
    
    checked++;
    if (checked % batchSize === 0) {
      process.stdout.write(`  Progress: ${checked}/${hostCount - arpDevices.length} (${Math.round((checked / (hostCount - arpDevices.length)) * 100)}%)\r`);
    }
  }
  
  console.log(`\n`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         WiFi Module Discovery Tool                           ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("\n");
  
  const localIP = getLocalIP();
  
  if (!localIP) {
    console.error("❌ Could not determine local IP address");
    console.log("\n💡 Please ensure you're connected to WiFi and try again.");
    process.exit(1);
  }
  
  console.log(`📍 Your Local IP: ${localIP}\n`);
  
  const networkCIDR = getNetworkCIDR(localIP);
  
  if (!networkCIDR) {
    console.error("❌ Could not determine network CIDR");
    process.exit(1);
  }
  
  console.log(`🌐 Network: ${networkCIDR}\n`);
  
  // Common ports for WiFi module web interfaces
  const portsToScan = [80, 8080, 8000, 8888, 80];
  
  // Also check ARP table first
  const arpDevices = getARPDevices();
  if (arpDevices.length > 0) {
    console.log(`📋 Devices in ARP table (${arpDevices.length}):`);
    arpDevices.slice(0, 10).forEach(device => {
      console.log(`   • ${device.ip}${device.mac ? ` (${device.mac})` : ''}`);
    });
    if (arpDevices.length > 10) {
      console.log(`   ... and ${arpDevices.length - 10} more`);
    }
    console.log("");
  }
  
  const found = await scanForWebInterfaces(networkCIDR, portsToScan);
  
  console.log("═".repeat(63));
  console.log("📋 DISCOVERY RESULTS");
  console.log("═".repeat(63));
  
  if (found.length > 0) {
    console.log(`\n✅ Found ${found.length} web interface(s):\n`);
    found.forEach((device, index) => {
      console.log(`   ${index + 1}. http://${device.ip}:${device.port}`);
      if (device.title) {
        console.log(`      Title: ${device.title}`);
      }
      console.log(`      Status: ${device.status}`);
      console.log("");
    });
    console.log("💡 These are potential WiFi module web interfaces.");
    console.log("   Open them in your browser to configure the scales.");
  } else {
    console.log(`\n⚠️  No web interfaces found on common ports (${portsToScan.join(", ")})`);
    console.log("\n💡 Try these alternatives:");
    console.log("   1. Check your router's DHCP client list for unknown devices");
    console.log("   2. Look for WiFi networks named like 'ESP8266' or 'WiFi Module'");
    console.log("   3. Some modules use default IPs like 192.168.4.1 (AP mode)");
    console.log("   4. Check scale documentation for default IP addresses");
    console.log("\n💡 You can also scan specific IPs manually:");
    console.log(`   curl http://192.168.1.X:80`);
    console.log(`   curl http://192.168.1.X:8080`);
  }
  
  console.log("\n");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
