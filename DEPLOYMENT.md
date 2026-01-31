# 🚀 Production Deployment Guide

This guide covers deploying CarniTrack Edge Service in production using Docker.

## 📋 Prerequisites

- Docker Engine 20.10+ or Docker Desktop
- Docker Compose v2.0+
- At least 512MB RAM available
- Network access to Cloud API endpoint
- Ports 3000 (HTTP) and 8899 (TCP) available

## 🐳 Quick Start

### 1. Clone and Configure

```bash
# Clone repository
git clone <repository-url>
cd carnitrack-edge

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### 2. Configure Environment Variables

Edit `.env` file with your production settings:

```bash
# Required: Site configuration
EDGE_NAME="Main Production Facility"
SITE_ID="site-prod-001"
CLOUD_API_URL="https://api.carnitrack.com/api/v1/edge"

# Optional: Customize ports if needed
TCP_PORT=8899
HTTP_PORT=3000
```

### 3. Start Services

**Development:**
```bash
docker compose up -d
```

**Production (with resource limits):**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 4. Verify Deployment

```bash
# Check container status
docker compose ps

# View logs
docker compose logs -f carnitrack-edge

# Check health endpoint
curl http://localhost:3000/health
```

## 📦 Docker Compose Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Base configuration (dev/prod) |
| `docker-compose.prod.yml` | Production overrides (resource limits, security) |

## 🔧 Configuration

### Environment Variables

See `.env.example` for all available configuration options.

**Critical Variables:**

| Variable | Description | Required |
|----------|-------------|----------|
| `SITE_ID` | Site identifier from Cloud | Yes |
| `CLOUD_API_URL` | Cloud REST API endpoint | Yes |
| `TCP_PORT` | Port for scale connections | No (default: 8899) |
| `HTTP_PORT` | Port for admin dashboard | No (default: 3000) |

### Port Mapping

- **3000** → HTTP Admin Dashboard & API
- **8899** → TCP Server (DP-401 scales connect here)

To change ports, update both `.env` and `docker-compose.yml`:

```yaml
ports:
  - "${HTTP_PORT:-3000}:3000"
  - "${TCP_PORT:-8899}:8899"
```

## 💾 Data Persistence

Data is stored in Docker volumes:

| Volume | Purpose | Critical |
|--------|---------|----------|
| `carnitrack-edge-data` | SQLite database | ✅ **YES** |
| `carnitrack-edge-logs` | Application logs | No |
| `carnitrack-edge-generated` | Generated PLU files | No |

### Backup Database

```bash
# Create backup
docker run --rm \
  -v carnitrack-edge-data:/data \
  -v $(pwd):/backup \
  alpine \
  cp /data/carnitrack.db /backup/carnitrack-backup-$(date +%Y%m%d).db

# Restore from backup
docker run --rm \
  -v carnitrack-edge-data:/data \
  -v $(pwd):/backup \
  alpine \
  cp /backup/carnitrack-backup-YYYYMMDD.db /data/carnitrack.db
```

### List Volumes

```bash
docker volume ls | grep carnitrack
```

## 🔄 Updates & Maintenance

### Update Application

```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose build
docker compose up -d --force-recreate
```

### View Logs

```bash
# Follow logs
docker compose logs -f carnitrack-edge

# Last 100 lines
docker compose logs --tail=100 carnitrack-edge

# Logs with timestamps
docker compose logs -f --timestamps carnitrack-edge
```

### Restart Service

```bash
# Restart container
docker compose restart carnitrack-edge

# Full restart (recreate)
docker compose up -d --force-recreate carnitrack-edge
```

### Stop Service

```bash
# Stop containers (keeps volumes)
docker compose down

# Stop and remove volumes (⚠️ DESTRUCTIVE)
docker compose down -v
```

## 🏥 Health Checks

The container includes a health check that monitors the HTTP endpoint:

```bash
# Check container health
docker compose ps

# Manual health check
curl http://localhost:3000/health

# Expected response:
{
  "status": "ok",
  "timestamp": "2026-01-30T...",
  "edgeId": "...",
  "cloudConnection": "connected",
  "offlineMode": false,
  "tcpConnections": 2
}
```

## 🔒 Security Best Practices

### Production Checklist

- [ ] Use strong, unique `SITE_ID`
- [ ] Set `LOG_LEVEL=info` (not `debug`)
- [ ] Use `docker-compose.prod.yml` for resource limits
- [ ] Regularly backup `carnitrack-edge-data` volume
- [ ] Monitor logs for errors
- [ ] Keep Docker and images updated
- [ ] Use firewall rules to restrict TCP port access
- [ ] Use HTTPS reverse proxy for HTTP port (if exposed)

### Network Security

```bash
# Only expose TCP port to local network
# In docker-compose.yml, bind to specific interface:
ports:
  - "127.0.0.1:3000:3000"  # HTTP only on localhost
  - "192.168.1.100:8899:8899"  # TCP on specific IP
```

## 📊 Monitoring

### Container Metrics

```bash
# Resource usage
docker stats carnitrack-edge

# Container info
docker inspect carnitrack-edge
```

### Application Metrics

Access admin dashboard at `http://localhost:3000`:

- **Status** - System health, Cloud connection
- **Devices** - Connected scales, heartbeat status
- **Events** - Recent events, sync status
- **Sessions** - Active sessions from Cloud

### API Endpoints

```bash
# System status
curl http://localhost:3000/api/status

# List devices
curl http://localhost:3000/api/devices

# TCP connections
curl http://localhost:3000/api/tcp/connections

# Recent events
curl http://localhost:3000/api/events?limit=10
```

## 🐛 Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs carnitrack-edge

# Check container status
docker compose ps

# Inspect container
docker inspect carnitrack-edge
```

### Database Issues

```bash
# Check database file exists
docker run --rm -v carnitrack-edge-data:/data alpine ls -la /data

# Verify database integrity
docker run --rm -v carnitrack-edge-data:/data alpine \
  sqlite3 /data/carnitrack.db "PRAGMA integrity_check;"
```

### Port Already in Use

```bash
# Find process using port
lsof -i :3000
lsof -i :8899

# Change ports in .env and restart
docker compose down
# Edit .env
docker compose up -d
```

### Cloud Connection Issues

```bash
# Check Cloud API connectivity
docker exec carnitrack-edge \
  bun --eval "fetch('${CLOUD_API_URL}/health').then(r => console.log(r.status))"

# View connection logs
docker compose logs carnitrack-edge | grep -i cloud
```

## 🔄 Scaling

For multiple Edge instances (different sites):

1. Create separate directories for each site
2. Use different `.env` files with unique `SITE_ID`
3. Use different port mappings
4. Use separate Docker Compose projects

```bash
# Site 1
cd /opt/carnitrack-edge-site1
docker compose -p carnitrack-site1 up -d

# Site 2
cd /opt/carnitrack-edge-site2
docker compose -p carnitrack-site2 up -d
```

## 📝 Production Checklist

Before going live:

- [ ] Configure `.env` with production values
- [ ] Test Cloud API connectivity
- [ ] Verify TCP port accessible from scales
- [ ] Set up database backups (automated)
- [ ] Configure log rotation
- [ ] Set up monitoring/alerting
- [ ] Test failover scenarios
- [ ] Document site-specific configuration
- [ ] Train operators on admin dashboard
- [ ] Set up health check monitoring

## 🆘 Support

For issues:

1. Check logs: `docker compose logs -f carnitrack-edge`
2. Verify health: `curl http://localhost:3000/health`
3. Check Cloud connectivity
4. Review this guide's troubleshooting section
5. Contact support with logs and configuration (redact secrets)

## 📚 Additional Resources

- [README.md](README.md) - General documentation
- [TCP_SERVER_API_CONTRACT.md](TCP_SERVER_API_CONTRACT.md) - TCP protocol details
- [CLOUD_INTEGRATION.md](CLOUD_INTEGRATION.md) - Cloud integration guide
