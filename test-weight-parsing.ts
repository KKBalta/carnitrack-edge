#!/usr/bin/env bun
/**
 * Test script to verify weight parsing fix
 */

import { ScaleParser } from "./src/devices/scale-parser.ts";

const parser = new ScaleParser();

// Test data from user
const testLine = "00001,01:44:22,30.01.2026,KIYMA           ,000000000001,0000,KAAN                                            ,0038319201,0000000000,0038319201,0,0,0,1,N,KORKUT KAAN BALTA";

console.log("Testing weight parsing...\n");
console.log("Input:", testLine);
console.log("");

const result = parser.parse("test", Buffer.from(testLine + "\n"));

if (result.packets.length > 0 && result.packets[0].type === "weighing_event") {
  const event = result.packets[0].event;
  console.log("Parsed Event:");
  console.log(`  PLU: ${event.pluCode}`);
  console.log(`  Product: ${event.productName}`);
  console.log(`  Weight: ${event.weightGrams} grams (${(event.weightGrams / 1000).toFixed(3)} kg)`);
  console.log(`  Expected: 38319201 grams`);
  console.log(`  Match: ${event.weightGrams === 38319201 ? "✓ CORRECT" : "✗ INCORRECT"}`);
  console.log(`  Barcode: ${event.barcode}`);
  console.log(`  Operator: ${event.operator}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);
  console.log(`  Value1 (field[8]): ${event.value1}`);
  console.log(`  Value2 (field[9]): ${event.value2}`);
} else {
  console.error("Failed to parse event!");
  console.error("Packets:", result.packets);
  console.error("Errors:", result.errors);
}
