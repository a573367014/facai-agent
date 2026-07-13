import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const importPattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return sourceExtensions.has(extname(entry.name)) ? [path] : [];
    })
  );
  return files.flat();
}

async function importsIn(directory) {
  const imports = [];
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      imports.push({ file, specifier: match[1] });
    }
  }
  return imports;
}

function relativeToRepository(path) {
  return path.slice(repositoryRoot.length + 1);
}

test("API lower layers never import bootstrap or process entrypoints", async () => {
  const lowerLayers = ["modules", "platform", "shared"];
  const violations = [];

  for (const layer of lowerLayers) {
    const directory = resolve(repositoryRoot, "apps/api/src", layer);
    for (const entry of await importsIn(directory)) {
      if (entry.specifier.includes("/bootstrap/") || entry.specifier.includes("/entrypoints/")) {
        violations.push(`${relativeToRepository(entry.file)} -> ${entry.specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("API business modules remain acyclic", async () => {
  const modulesRoot = resolve(repositoryRoot, "apps/api/src/modules");
  const modules = (await readdir(modulesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const dependencyGraph = new Map(modules.map((module) => [module, new Set()]));

  for (const module of modules) {
    for (const entry of await importsIn(resolve(modulesRoot, module))) {
      if (!entry.specifier.startsWith(".")) {
        continue;
      }
      const targetPath = resolve(dirname(entry.file), entry.specifier);
      const target = targetPath.startsWith(`${modulesRoot}/`)
        ? targetPath.slice(modulesRoot.length + 1).split("/")[0]
        : undefined;
      if (target && target !== module && dependencyGraph.has(target)) {
        dependencyGraph.get(module).add(target);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(module) {
    if (visiting.has(module)) {
      const cycleStart = stack.indexOf(module);
      return [...stack.slice(cycleStart), module].join(" -> ");
    }
    if (visited.has(module)) {
      return undefined;
    }

    visiting.add(module);
    stack.push(module);
    for (const dependency of dependencyGraph.get(module)) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(module);
    visited.add(module);
    return undefined;
  }

  const cycle = modules.map(visit).find(Boolean);
  assert.equal(cycle, undefined, cycle ? `module dependency cycle: ${cycle}` : undefined);
});

test("Web shared infrastructure never imports app or feature implementations", async () => {
  const directory = resolve(repositoryRoot, "apps/web/src/shared");
  const violations = (await importsIn(directory))
    .filter(
      ({ specifier }) =>
        specifier.startsWith("@/app") ||
        specifier.startsWith("@/features") ||
        specifier.includes("/app/") ||
        specifier.includes("/features/")
    )
    .map(({ file, specifier }) => `${relativeToRepository(file)} -> ${specifier}`);

  assert.deepEqual(violations, []);
});

test("Web feature dependencies remain acyclic", async () => {
  const featuresRoot = resolve(repositoryRoot, "apps/web/src/features");
  const features = (await readdir(featuresRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const dependencyGraph = new Map(features.map((feature) => [feature, new Set()]));

  for (const feature of features) {
    for (const { specifier } of await importsIn(resolve(featuresRoot, feature))) {
      const target = specifier.match(/^@\/features\/([^/]+)/)?.[1];
      if (target && target !== feature && dependencyGraph.has(target)) {
        dependencyGraph.get(feature).add(target);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(feature) {
    if (visiting.has(feature)) {
      const cycleStart = stack.indexOf(feature);
      return [...stack.slice(cycleStart), feature].join(" -> ");
    }
    if (visited.has(feature)) {
      return undefined;
    }

    visiting.add(feature);
    stack.push(feature);
    for (const dependency of dependencyGraph.get(feature)) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(feature);
    visited.add(feature);
    return undefined;
  }

  const cycle = features.map(visit).find(Boolean);
  assert.equal(cycle, undefined, cycle ? `feature dependency cycle: ${cycle}` : undefined);
});

test("Shared contracts stay independent from application source", async () => {
  const directory = resolve(repositoryRoot, "packages/contracts/src");
  const violations = (await importsIn(directory))
    .filter(({ specifier }) => specifier.includes("apps/") || specifier.startsWith("@/"))
    .map(({ file, specifier }) => `${relativeToRepository(file)} -> ${specifier}`);

  assert.deepEqual(violations, []);
});
