#!/usr/bin/env bun
/**
 * Find WiFi Scale Network Discovery Tool
 * 
 * Helps locate DP-401 WiFi scales on the network that may not appear in ARP tables.
 * 
 * Usage:
 *   bun scripts/find-scale.ts [options]
 * 
 * Options:
 *   --port <port>     TCP port to scan (default: 8899)
 *   --network <cidr>  Network CIDR to scan (default: auto-detect)
 *   --check-tcp      Check if TCP server is running
 *   --check-connections  Check active TCP connections
 *   --scan           Scan network for potential scale devices
 */

import { config } from "../src/config.ts";

interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get local network interfaces
 */
function getNetworkInterfaces(): NetworkInterface[] {
  const interfaces: NetworkInterface[] = [];
  
  try {
    // Use Bun's network utilities or system commands
    const result = Bun.spawnSync(["ifconfig"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (result.success) {
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");
      
      let currentInterface: Partial<NetworkInterface> | null = null;
      
      for (const line of lines) {
        // Interface name (e.g., "en0:")
        const ifaceMatch = line.match(/^(\w+):/);
        if (ifaceMatch) {
          if (currentInterface && currentInterface.name) {
            interfaces.push(currentInterface as NetworkInterface);
          }
          currentInterface = { name: ifaceMatch[1] };
        }
        
        // IP address (inet)
        const inetMatch = line.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        if (inetMatch && currentInterface) {
          currentInterface.address = inetMatch[1];
        }
        
        // Netmask
        const netmaskMatch = line.match(/netmask (0x[a-f0-9]+|\d+\.\d+\.\d+\.\d+)/);
        if (netmaskMatch && currentInterface) {
          currentInterface.netmask = netmaskMatch[1];
        }
      }
      
      if (currentInterface && currentInterface.name && currentInterface.address) {
        interfaces.push(currentInterface as NetworkInterface);
      }
    }
  } catch (error) {
    console.error("Failed to get network interfaces:", error);
  }
  
  // Calculate CIDR from netmask
  return interfaces.map(iface => {
    let cidr = "24"; // Default /24
    if (iface.netmask) {
      if (iface.netmask.startsWith("0x")) {
        // Hex netmask
        const hex = parseInt(iface.netmask, 16);
        const bits = (hex >>> 0).toString(2).split("1").length - 1;
        cidr = bits.toString();
      } else {
        // Dotted decimal netmask
        const parts = iface.netmask.split(".").map(Number);
        const binary = parts.map(p => p.toString(2).padStart(8, "0")).join("");
        const bits = binary.split("1").length - 1;
        cidr = bits.toString();
      }
    }
    
    // Extract network prefix
    const ipParts = iface.address.split(".").map(Number);
    const networkPrefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
    
    return {
      ...iface,
      cidr: `${networkPrefix}.0/${cidr}`,
    };
  });
}

/**
 * Check if TCP server is running and listening
 */
async function checkTCPServer(port: number): Promise<boolean> {
  try {
    // Try to connect to the TCP server
    const socket = await Bun.connect({
      hostname: "localhost",
      port: port,
    });
    
    socket.end();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check active TCP connections on the server port
 */
function checkActiveConnections(port: number): void {
  console.log(`\n📡 Checking active TCP connections on port ${port}...`);
  
  try {
    // Use netstat or lsof to check connections
    const netstatResult = Bun.spawnSync(["netstat", "-an"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (netstatResult.success) {
      const output = new TextDecoder().decode(netstatResult.stdout);
      const lines = output.split("\n");
      
      const connections = lines.filter(line => 
        line.includes(`.${port}`) || line.includes(`:${port}`)
      );
      
      if (connections.length > 0) {
        console.log(`\n✓ Found ${connections.length} connection(s) on port ${port}:`);
        connections.forEach(conn => {
          console.log(`  ${conn.trim()}`);
        });
      } else {
        console.log(`\n⚠️  No active connections found on port ${port}`);
        console.log(`   Make sure your TCP server is running and scales are connected.`);
      }
    }
  } catch (error) {
    console.error("Failed to check connections:", error);
  }
  
  // Also try lsof (macOS/Linux)
  try {
    const lsofResult = Bun.spawnSync(["lsof", "-i", `:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    
    if (lsofResult.success) {
      const output = new TextDecoder().decode(lsofResult.stdout);
      if (output.trim()) {
        console.log(`\n✓ Active connections (lsof):`);
        console.log(output);
      }
    }
  } catch (error) {
    // lsof might not be available, that's okay
  }
}

/**
 * Scan network for potential scale devices
 */
async function scanNetwork(cidr: string, port: number): Promise<void> {
  console.log(`\n🔍 Scanning network ${cidr} for devices on port ${port}...`);
  console.log(`   This may take a while...\n`);
  
  // Extract network range
  const [network, prefix] = cidr.split("/");
  const prefixLength = parseInt(prefix || "24", 10);
  const networkParts = network.split(".").map(Number);
  
  // Calculate IP range
  const hostBits = 32 - prefixLength;
  const hostCount = Math.pow(2, hostBits) - 2; // Exclude network and broadcast
  
  if (hostCount > 254) {
    console.log(`⚠️  Network too large (${hostCount} hosts). Limiting scan to first 254 hosts.`);
  }
  
  const maxHosts = Math.min(hostCount, 254);
  const foundDevices: Array<{ ip: string; port: number; latency?: number }> = [];
  
  // Scan in parallel batches
  const batchSize = 10;
  const batches: string[][] = [];
  
  for (let i = 1; i <= maxHosts; i++) {
    const ip = `${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`;
    const batchIndex = Math.floor((i - 1) / batchSize);
    if (!batches[batchIndex]) batches[batchIndex] = [];
    batches[batchIndex].push(ip);
  }
  
  for (const batch of batches) {
    const promises = batch.map(async (ip) => {
      try {
        const start = Date.now();
        const socket = await Bun.connect({
          hostname: ip,
          port: port,
          connectTimeout: 1000, // 1 second timeout
        });
        
        const latency = Date.now() - start;
        socket.end();
        
        return { ip, port, latency };
      } catch (error) {
        return null;
      }
    });
    
    const results = await Promise.all(promises);
    const devices = results.filter((r): r is { ip: string; port: number; latency?: number } => r !== null);
    
    if (devices.length > 0) {
      foundDevices.push(...devices);
      devices.forEach(device => {
        console.log(`  ✓ Found device: ${device.ip}:${device.port} (latency: ${device.latency}ms)`);
      });
    }
    
    // Show progress
    process.stdout.write(".");
  }
  
  console.log("\n");
  
  if (foundDevices.length > 0) {
    console.log(`\n✅ Found ${foundDevices.length} potential scale device(s):`);
    foundDevices.forEach(device => {
      console.log(`   ${device.ip}:${device.port} (${device.latency}ms)`);
    });
    console.log(`\n💡 Tip: Check if these devices are your scales by looking at their IP addresses.`);
    console.log(`   You can also check your router's DHCP client list for device names.`);
  } else {
    console.log(`\n⚠️  No devices found listening on port ${port}.`);
    console.log(`\n💡 Troubleshooting tips:`);
    console.log(`   1. Make sure your TCP server is running: bun run src/index.ts`);
    console.log(`   2. Check that scales are powered on and WiFi is connected`);
    console.log(`   3. Verify scale WiFi configuration:`);
    console.log(`      - Server Address: Your Edge server IP`);
    console.log(`      - Port: ${port}`);
    console.log(`      - Protocol: TCP-Client`);
    console.log(`   4. Check firewall settings (port ${port} should be open)`);
    console.log(`   5. Try checking your router's DHCP client list for scale MAC addresses`);
  }
}

/**
 * Check Edge server status via HTTP API
 */
async function checkEdgeServerStatus(): Promise<void> {
  const httpPort = config.http.port;
  const httpHost = config.http.host === "0.0.0.0" ? "localhost" : config.http.host;
  
  try {
    const response = await fetch(`http://${httpHost}:${httpPort}/api/status`);
    if (response.ok) {
      const data = await response.json();
      
      console.log(`\n✅ Edge server is running:`);
      console.log(`   HTTP: http://${httpHost}:${httpPort}`);
      console.log(`   TCP: ${config.tcp.host}:${config.tcp.port}`);
      console.log(`   Connected devices: ${data.data?.devices ? Object.keys(data.data.devices).length : 0}`);
      
      // Check TCP connections
      const tcpResponse = await fetch(`http://${httpHost}:${httpPort}/api/tcp/connections`);
      if (tcpResponse.ok) {
        const tcpData = await tcpResponse.json();
        const connections = tcpData.data || [];
        
        if (connections.length > 0) {
          console.log(`\n📡 Active TCP connections:`);
          connections.forEach((conn: any) => {
            console.log(`   ${conn.deviceId || "Unregistered"} from ${conn.remoteAddress}`);
            console.log(`      Connected: ${conn.connectedAt}`);
          });
        } else {
          console.log(`\n⚠️  No active TCP connections`);
        }
      }
    }
  } catch (error) {
    console.log(`\n⚠️  Edge server HTTP API not accessible (is it running?)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  
  let port = config.tcp.port;
  let networkCidr: string | null = null;
  let checkTCP = false;
  let checkConnections = false;
  let scan = false;
  let checkStatus = true;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (arg === "--network" && args[i + 1]) {
      networkCidr = args[++i];
    } else if (arg === "--check-tcp") {
      checkTCP = true;
    } else if (arg === "--check-connections") {
      checkConnections = true;
    } else if (arg === "--scan") {
      scan = true;
    } else if (arg === "--no-status") {
      checkStatus = false;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Find WiFi Scale Network Discovery Tool

Usage:
  bun scripts/find-scale.ts [options]

Options:
  --port <port>              TCP port to scan (default: ${config.tcp.port})
  --network <cidr>           Network CIDR to scan (e.g., 192.168.1.0/24)
  --check-tcp               Check if TCP server is running
  --check-connections       Check active TCP connections
  --scan                    Scan network for potential scale devices
  --no-status               Skip checking Edge server status
  --help, -h                Show this help message

Examples:
  # Check Edge server status and connections
  bun scripts/find-scale.ts --check-status --check-connections

  # Scan local network for scales
  bun scripts/find-scale.ts --scan

  # Scan specific network
  bun scripts/find-scale.ts --scan --network 192.168.1.0/24
`);
      process.exit(0);
    }
  }
  
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         WiFi Scale Network Discovery Tool                    ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log(`\nTCP Port: ${port}`);
  
  // Check Edge server status
  if (checkStatus) {
    await checkEdgeServerStatus();
  }
  
  // Check TCP server
  if (checkTCP) {
    console.log(`\n🔍 Checking if TCP server is listening on port ${port}...`);
    const isRunning = await checkTCPServer(port);
    if (isRunning) {
      console.log(`✅ TCP server is running and accepting connections`);
    } else {
      console.log(`⚠️  TCP server is not accessible on port ${port}`);
      console.log(`   Start the Edge server: bun run src/index.ts`);
    }
  }
  
  // Check active connections
  if (checkConnections) {
    checkActiveConnections(port);
  }
  
  // Scan network
  if (scan) {
    if (!networkCidr) {
      // Auto-detect network
      const interfaces = getNetworkInterfaces();
      const activeInterface = interfaces.find(iface => 
        iface.address && 
        !iface.address.startsWith("127.") && 
        !iface.address.startsWith("169.254.")
      );
      
      if (activeInterface && activeInterface.cidr) {
        networkCidr = activeInterface.cidr;
        console.log(`\n📡 Auto-detected network: ${activeInterface.name} (${activeInterface.address})`);
        console.log(`   Using CIDR: ${networkCidr}`);
      } else {
        console.log(`\n⚠️  Could not auto-detect network. Please specify with --network <cidr>`);
        console.log(`   Example: --network 192.168.1.0/24`);
        process.exit(1);
      }
    }
    
    await scanNetwork(networkCidr, port);
  }
  
  // If no specific actions, show summary
  if (!checkTCP && !checkConnections && !scan) {
    console.log(`\n💡 Usage tips:`);
    console.log(`   • Check Edge server status: bun scripts/find-scale.ts`);
    console.log(`   • Check TCP connections: bun scripts/find-scale.ts --check-connections`);
    console.log(`   • Scan network: bun scripts/find-scale.ts --scan`);
    console.log(`   • Full scan: bun scripts/find-scale.ts --check-connections --scan`);
    console.log(`\n📝 Note: Scales connect as TCP clients, so they won't appear in ARP`);
    console.log(`   until they actually connect to your Edge server.`);
  }
  
  console.log("\n");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
