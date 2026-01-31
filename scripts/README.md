# Scripts

Utility scripts for CarniTrack Edge.

## create-env.ts / create-env.sh

Generate `.env` configuration files from the config definitions.

### TypeScript Version (Recommended)

**Interactive Mode:**
```bash
bun scripts/create-env.ts
```
Prompts for each environment variable with defaults shown. Press Enter to use defaults.

**Template Mode:**
```bash
bun scripts/create-env.ts --template
# or
bun scripts/create-env.ts -t
```
Generates `.env.example` with all variables commented out showing defaults.

**Custom Output:**
```bash
bun scripts/create-env.ts --output .env.local
# or
bun scripts/create-env.ts -o .env.local
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
- `REGISTRATION_TOKEN` - Site registration token (for initial Cloud registration)

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
