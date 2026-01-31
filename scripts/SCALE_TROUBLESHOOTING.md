# WiFi Scale Troubleshooting Guide

## Found Scale Information

**Device:** SCALE-01  
**Last Known IP:** `192.168.1.163`  
**Status:** Disconnected  
**Last Connected:** 2026-01-30 10:27:02  
**Last Heartbeat:** 2026-01-30 10:27:43

---

## Quick Discovery Commands

### 1. Check if Edge Server is Running
```bash
bun scripts/find-scale.ts --check-status --check-connections
```

### 2. Check Active TCP Connections
```bash
# Check what's connected to port 8899
lsof -i :8899
# or
netstat -an | grep 8899
```

### 3. Check Your Router's DHCP Client List
- Log into your router admin panel (usually `192.168.1.1` or `192.168.0.1`)
- Look for devices with MAC addresses that might be your scale
- Check for device names like "DP-401" or "WiFi Module"

### 4. Ping the Last Known IP
```bash
ping 192.168.1.163
```

### 5. Scan Network for Scale Devices
```bash
# Auto-detect network and scan
bun scripts/find-scale.ts --scan

# Or specify network manually
bun scripts/find-scale.ts --scan --network 192.168.1.0/24
```

---

## Why Scales Don't Appear in ARP

**Important:** Scales connect as **TCP clients** to your Edge server. They won't appear in `arp -a` until they:
1. Are powered on
2. Are connected to WiFi
3. Successfully connect to your Edge server on port 8899

The ARP table only shows devices that have communicated on your local network segment. If the scale hasn't connected yet, it won't be in ARP.

---

## Troubleshooting Steps

### Step 1: Verify Edge Server is Running
```bash
# Check if Edge server is listening
curl http://localhost:3000/api/status

# Or check processes
ps aux | grep bun
```

### Step 2: Check Scale WiFi Configuration

The scale's WiFi module needs to be configured with:
- **Protocol:** TCP-Client
- **Server Address:** Your Edge server IP (check with `ifconfig` or `ipconfig`)
- **Port:** 8899
- **Register Package Enable:** ON
- **Register Package Data:** SCALE-01 (or SCALE-02, etc.)
- **Register Package Send Mode:** link (send on connection)
- **Heartbeat Interval:** 30 seconds
- **Heartbeat Data:** HB

### Step 3: Verify Network Connectivity

```bash
# Find your Edge server IP
ifconfig | grep "inet " | grep -v 127.0.0.1

# Test if scale can reach your server (from scale's perspective)
# You might need to check the scale's WiFi module web interface
```

### Step 4: Check Firewall

Make sure port 8899 is open:
```bash
# macOS
sudo pfctl -sr | grep 8899

# Check if port is listening
lsof -i :8899
```

### Step 5: Monitor TCP Connections

Watch for new connections:
```bash
# Monitor TCP connections in real-time
watch -n 1 'lsof -i :8899'

# Or check Edge server logs
tail -f logs/*.log
```

### Step 6: Check Scale Power and WiFi

1. **Power:** Make sure the scale is powered on
2. **WiFi LED:** Check if WiFi module LED indicates connection
3. **WiFi Signal:** Ensure scale is within WiFi range
4. **WiFi Credentials:** Verify scale is connected to the correct WiFi network

---

## Finding the Scale IP Address

### Method 1: Check Router DHCP Client List
- Most reliable method
- Shows all connected devices with their IPs
- Look for device names or MAC addresses

### Method 2: Use Network Scanner
```bash
# Install nmap if not available
brew install nmap  # macOS
# or
sudo apt-get install nmap  # Linux

# Scan network for devices
nmap -sn 192.168.1.0/24

# Scan for specific port
nmap -p 8899 192.168.1.0/24
```

### Method 3: Use the Discovery Script
```bash
bun scripts/find-scale.ts --scan --network 192.168.1.0/24
```

### Method 4: Check Scale WiFi Module Web Interface
- Some WiFi modules have a web interface
- Usually accessible at `http://192.168.1.163` (last known IP)
- Or check scale documentation for default IP

---

## Common Issues

### Issue: Scale Not Connecting

**Possible Causes:**
1. Scale WiFi module not configured correctly
2. Wrong server IP address in scale config
3. Firewall blocking port 8899
4. Scale and Edge server on different networks
5. Scale WiFi module not connected to WiFi

**Solutions:**
- Verify scale WiFi configuration matches Edge server IP
- Check firewall rules
- Ensure both devices are on same network
- Restart scale WiFi module

### Issue: Scale Connects Then Disconnects

**Possible Causes:**
1. Network instability
2. WiFi signal too weak
3. Edge server restarting
4. Scale power issues

**Solutions:**
- Check WiFi signal strength
- Monitor Edge server logs
- Check scale power supply
- Verify network stability

### Issue: Scale IP Changed

**Possible Causes:**
1. DHCP lease expired
2. Router assigned new IP
3. Scale reconnected to different network

**Solutions:**
- Check router DHCP client list for new IP
- Consider setting static IP for scale
- Re-scan network with discovery script

---

## Monitoring Scale Connection

### Real-time Monitoring
```bash
# Watch Edge server logs
tail -f logs/*.log | grep -i scale

# Monitor TCP connections
watch -n 1 'curl -s http://localhost:3000/api/devices | jq'
```

### Check via API
```bash
# Get all devices
curl http://localhost:3000/api/devices

# Get TCP connections
curl http://localhost:3000/api/tcp/connections

# Get system status
curl http://localhost:3000/api/status
```

---

## Next Steps

1. **Verify Edge server is running** - Check `http://localhost:3000`
2. **Check scale power and WiFi** - Ensure scale is on and connected
3. **Verify scale WiFi configuration** - Server IP should match your Edge server
4. **Check router DHCP list** - Find scale's current IP
5. **Monitor connections** - Watch for scale to connect
6. **Check logs** - Look for connection attempts in Edge server logs

---

## Quick Reference

**Edge Server:**
- TCP Port: 8899
- HTTP Port: 3000
- Admin Dashboard: http://localhost:3000

**Scale Last Known:**
- IP: 192.168.1.163
- Device ID: SCALE-01
- Status: Disconnected

**Discovery Script:**
```bash
bun scripts/find-scale.ts --help
```
