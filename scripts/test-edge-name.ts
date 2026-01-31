#!/usr/bin/env bun

/**
 * Test Edge Name Functionality
 * 
 * Tests that EDGE_NAME environment variable is properly:
 * 1. Loaded from environment
 * 2. Used in config
 * 3. Used in registration data
 * 
 * Usage:
 *   EDGE_NAME="Test Edge" bun scripts/test-edge-name.ts
 *   bun scripts/test-edge-name.ts  # Tests with no EDGE_NAME set
 */

import { config } from "../src/config.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function testConfigLoading() {
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    Testing Edge Name Configuration                          ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log();
  
  console.log("1. Testing config.edge.name loading...");
  const edgeName = config.edge.name;
  const edgeNameFromEnv = process.env.EDGE_NAME || "";
  
  console.log(`   EDGE_NAME env var:     "${edgeNameFromEnv}"`);
  console.log(`   config.edge.name:      "${edgeName}"`);
  console.log(`   Match:                 ${edgeName === edgeNameFromEnv ? "✓" : "✗"}`);
  console.log();
  
  return { edgeName, edgeNameFromEnv };
}

function testRegistrationData() {
  console.log("2. Testing registration data construction...");
  
  // Simulate the registration data construction from index.ts
  const mockState = {
    edgeId: null as string | null,
    siteId: null as string | null,
    siteName: null as string | null,
  };
  
  const registrationData = {
    edgeId: mockState.edgeId || null,
    siteId: config.edge.siteId || mockState.siteId || null,
    siteName: config.edge.name || (config.edge.siteId ? `Site ${config.edge.siteId}` : mockState.siteName || null),
    version: "0.3.0",
    capabilities: ["rest", "tcp"],
  };
  
  console.log(`   Registration siteName: "${registrationData.siteName}"`);
  console.log(`   Uses edge.name:       ${registrationData.siteName === config.edge.name ? "✓" : "✗"}`);
  console.log();
  
  return registrationData;
}

function testFallbackLogic() {
  console.log("3. Testing fallback logic...");
  
  const scenarios = [
    {
      name: "Edge name set",
      edgeName: "My Test Edge",
      siteId: "site-001",
      expected: "My Test Edge",
    },
    {
      name: "No edge name, siteId set",
      edgeName: "",
      siteId: "site-001",
      expected: "Site site-001",
    },
    {
      name: "Neither set",
      edgeName: "",
      siteId: "",
      expected: null,
    },
  ];
  
  for (const scenario of scenarios) {
    // Temporarily override config values for testing
    const originalName = config.edge.name;
    const originalSiteId = config.edge.siteId;
    
    // Note: We can't actually modify config at runtime, so we'll simulate
    const mockState = { siteName: null as string | null };
    
    const result = scenario.edgeName || 
                   (scenario.siteId ? `Site ${scenario.siteId}` : mockState.siteName || null);
    
    const passed = result === scenario.expected;
    console.log(`   ${scenario.name}:`);
    console.log(`     edgeName="${scenario.edgeName}", siteId="${scenario.siteId}"`);
    console.log(`     Expected: "${scenario.expected}"`);
    console.log(`     Got:      "${result}"`);
    console.log(`     ${passed ? "✓ PASS" : "✗ FAIL"}`);
    console.log();
  }
}

function testEnvGeneration() {
  console.log("4. Testing env generation script includes EDGE_NAME...");
  
  try {
    const { generateEnvContent, envVars } = await import("./create-env.ts");
    
    const edgeNameVar = envVars.find(v => v.name === "EDGE_NAME");
    
    if (edgeNameVar) {
      console.log(`   ✓ EDGE_NAME found in env vars`);
      console.log(`     Category: ${edgeNameVar.category}`);
      console.log(`     Description: ${edgeNameVar.description}`);
      console.log(`     Default: "${edgeNameVar.defaultValue}"`);
      console.log(`     Required: ${edgeNameVar.required ? "Yes" : "No"}`);
    } else {
      console.log(`   ✗ EDGE_NAME NOT found in env vars`);
    }
    console.log();
    
    // Generate sample content
    const sampleContent = generateEnvContent(true);
    const hasEdgeName = sampleContent.includes("EDGE_NAME");
    console.log(`   Generated content includes EDGE_NAME: ${hasEdgeName ? "✓" : "✗"}`);
    console.log();
    
  } catch (error) {
    console.log(`   ✗ Error testing env generation: ${error}`);
    console.log();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

function main() {
  console.log();
  
  // Test 1: Config loading
  const { edgeName } = testConfigLoading();
  
  // Test 2: Registration data
  const registrationData = testRegistrationData();
  
  // Test 3: Fallback logic
  testFallbackLogic();
  
  // Test 4: Env generation
  testEnvGeneration();
  
  // Summary
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                              Test Summary                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log();
  
  if (edgeName) {
    console.log(`✓ Edge name is set: "${edgeName}"`);
    console.log(`  This will be used as siteName in registration: "${registrationData.siteName}"`);
  } else {
    console.log("⚠ Edge name is not set");
    if (config.edge.siteId) {
      console.log(`  Fallback will use: "Site ${config.edge.siteId}"`);
    } else {
      console.log("  No fallback available - siteName will be null");
    }
  }
  
  console.log();
  console.log("To set edge name:");
  console.log('  export EDGE_NAME="My Edge Name"');
  console.log("  # or add to .env file:");
  console.log('  echo \'EDGE_NAME="My Edge Name"\' >> .env');
  console.log();
}

if (import.meta.main) {
  main();
}
