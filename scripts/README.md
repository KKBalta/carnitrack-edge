# Scripts

Utility scripts for CarniTrack Edge.

## create-env.ts / create-env.sh

Generate `.env` configuration files from the config definitions.

### TypeScript Version (Recommended)

**Quick Mode (default) – 2 prompts only:**
```bash
bun scripts/create-env.ts
```
Prompts only for `SITE_ID` and `EDGE_NAME`. `REGISTRATION_TOKEN` can be left empty and added later. Cloud URL defaults to your deployment.

**Non-interactive (use env vars):**
```bash
SITE_ID=site-001 EDGE_NAME="My Edge" bun scripts/create-env.ts -y
```
Skips prompts when values are in the environment. Use `-y` to skip overwrite confirmation.

**Template Mode (no prompts):**
```bash
bun scripts/create-env.ts --template
# or
bun scripts/create-env.ts -t
```
Generates `.env.example` with all variables commented out showing defaults.

**Full Interactive (all 30+ vars):**
```bash
bun scripts/create-env.ts --full
# or
bun scripts/create-env.ts -f
```

**Custom Output:**
```bash
bun scripts/create-env.ts -o .env.local
# Add -y to skip overwrite confirmation
```

### Shell Script Version

**Generate Template:**
```bash
./scripts/create-env.sh
```
Generates `.env.example` with all variables.

**Custom Output:**
```bash
./scripts/create-env.sh .env
```

### Required Variables

The following environment variables are **required** and must be set before running the application:

- `SITE_ID` - Site ID for registration (from Cloud setup)
- `REGISTRATION_TOKEN` - Site registration token (for initial Cloud registration; can be left empty and added later)

### Example Usage

1. **Generate template for documentation:**
   ```bash
   bun scripts/create-env.ts --template
   ```

2. **Create your local .env interactively:**
   ```bash
   bun scripts/create-env.ts --output .env
   ```

3. **Quick template generation (shell):**
   ```bash
   ./scripts/create-env.sh .env.example
   ```
