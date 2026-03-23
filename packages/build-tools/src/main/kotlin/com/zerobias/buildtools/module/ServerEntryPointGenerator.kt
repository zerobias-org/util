package com.zerobias.buildtools.module

import org.gradle.api.GradleException
import java.io.File

/**
 * Generates server-entry.ts — the combined entry point for running a Hub Module
 * as a standalone REST server in Docker.
 *
 * The generated server:
 * - Creates an Express app with JSON parsing
 * - Manages connections via POST /connections and PUT /connections/:id/disconnect
 * - Implements the generated Factory interface to supply the active module instance
 * - Mounts REST API routes via the generated install() function
 * - Listens on PORT env var (default 8888)
 */
object ServerEntryPointGenerator {

    /**
     * Derive the pascal-case module name from the OpenAPI spec.
     *
     * Follows the same logic as HubModuleCodegenGenerator.processOpenAPI():
     * 1. Read info.title, split by "/"
     * 2. Take last segment, strip "module-" prefix
     * 3. Check for x-impl-name override
     * 4. PascalCase the result
     *
     * @param projectDir Module project directory containing api.yml or full.yml
     */
    fun resolveModulePascalName(projectDir: File): String {
        val specFile = projectDir.resolve("full.yml").takeIf { it.exists() }
            ?: projectDir.resolve("api.yml").takeIf { it.exists() }
            ?: throw GradleException("Neither full.yml nor api.yml found in $projectDir")

        val text = specFile.readText()

        // Check for x-impl-name first (higher priority)
        val implNameMatch = Regex("""x-impl-name:\s*['"]?(\S+?)['"]?\s*$""", RegexOption.MULTILINE).find(text)
        if (implNameMatch != null) {
            return pascalCase(implNameMatch.groupValues[1])
        }

        // Fall back to info.title
        val titleMatch = Regex("""title:\s*['"]?([^'"}\n]+?)['"]?\s*$""", RegexOption.MULTILINE).find(text)
            ?: throw GradleException("Could not find info.title in ${specFile.name}")

        val title = titleMatch.groupValues[1].trim()
        val lastSegment = title.split("/").last()
        val stripped = lastSegment.removePrefix("module-")
        return pascalCase(stripped)
    }

    /**
     * Generate the server-entry.ts content.
     *
     * @param pascal PascalCase module name (e.g., "Github")
     * @return TypeScript source code for the server entry point
     */
    fun generate(pascal: String): String {
        val lower = pascal.lowercase()
        return """
import express from 'express';
import 'express-async-errors';
import { LoggerEngine } from '@zerobias-org/logger';

const logger = LoggerEngine.root();

async function main() {
  // Dynamic imports to avoid ESM circular dependency in generated model barrel.
  // The model index.ts has circular imports between model files and ObjectSerializer
  // that cause TDZ errors when loaded eagerly as top-level imports.
  const { ${pascal}Impl } = await import('../src/${pascal}Impl.js');
  const { install } = await import('./server/index.js');

  const connections: Record<string, InstanceType<typeof ${pascal}Impl>> = {};

  const factory = {
    async onRequest(req: express.Request) {
      const connectionId = req.headers['x-connection-id'] as string
        || Object.keys(connections)[0];
      if (!connections[connectionId]) throw new Error('No active connection');
      return Object.assign(connections[connectionId], {
        preAuthorize: async () => {}
      });
    },
    async afterRequest() {}
  };

  const app = express();
  app.use(express.json());

  // Compute non-sensitive profile fields from ConnectionProfile model metadata.
  // Fields with format 'password' are sensitive and excluded.
  const { ConnectionProfile } = await import('./model/ConnectionProfile.js');
  const nonsensitiveProfileFields: string[] = [];
  try {
    if (ConnectionProfile.attributeTypeMap) {
      for (const attr of ConnectionProfile.attributeTypeMap) {
        if (attr.format !== 'password') {
          nonsensitiveProfileFields.push(attr.name);
        }
      }
    }
  } catch (err) {
    logger.error('Could not read connection profile fields', err as Error);
  }

  // Health/metadata endpoint — must include nonsensitiveProfileFields for ModuleTestHarness
  app.get('/', (_req: express.Request, res: express.Response) => res.send({
    nonsensitiveProfileFields
  }));

  // Connection management
  app.post('/connections', async (req: express.Request, res: express.Response) => {
    const { connectionId, connectionProfile } = req.body;
    const id = connectionId || 'default';
    const impl = new ${pascal}Impl();
    connections[id] = impl;
    try {
      const state = await impl.connect(connectionProfile);
      res.send(state);
    } catch (e: any) {
      delete connections[id];
      res.status(500).send({ error: e.message });
    }
  });

  app.put('/connections/:connectionId/disconnect', async (req: express.Request, res: express.Response) => {
    const impl = connections[req.params.connectionId];
    if (impl) {
      await impl.disconnect();
      delete connections[req.params.connectionId];
    }
    res.send('Disconnected');
  });

  // Wire protocol: POST /connections/:connectionId/:method with { argMap }
  // This is the protocol used by Hub Node to invoke operations on the container.
  // Parameter names are resolved from manifest.json operationParams.
  const fs = await import('node:fs');
  const path = await import('node:path');
  // In Docker: /opt/module/generated/api/manifest.json (copied via COPY *.yml and generated/)
  // Locally: relative to project dir
  const manifestPath = path.join(process.cwd(), 'generated', 'api', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const opParams: Record<string, string[]> = manifest.operationParams || {};

  app.post('/connections/:connectionId/:method', async (req: express.Request, res: express.Response) => {
    const connection = connections[req.params.connectionId]
      || connections[Object.keys(connections)[0]];
    if (!connection) {
      res.status(404).send({ error: 'No active connection' });
      return;
    }

    const { method } = req.params;
    const { argMap } = req.body;

    // method = "OrganizationApi.listMyOrganizations"
    const [apiClassName, methodName] = method.split('.');
    const api = (connection as any)[`get${'$'}{apiClassName}`]();
    const meth = api[methodName];

    if (!meth) {
      res.status(404).send({ error: `Method not found: ${'$'}{method}` });
      return;
    }

    // Resolve param names from manifest and build positional args
    // Find operationId by matching ApiClass.method in manifest.operations
    let paramNames: string[] = [];
    for (const [opId, opMethod] of Object.entries(manifest.operations)) {
      if (opMethod === method) {
        paramNames = opParams[opId] || [];
        break;
      }
    }

    const args = paramNames.map(name => argMap?.[name]);

    try {
      const result = await meth.call(api, ...args);
      res.status(200).send(result);
    } catch (e: any) {
      const status = e.statusCode || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      try {
        // CoreError.toString() produces deserializable JSON
        res.end(e.toString());
      } catch {
        res.end(JSON.stringify({
          key: e.key || 'err.unknown',
          timestamp: new Date().toISOString(),
          message: e.message || 'Unknown Error',
          args: e.args || {},
          statusCode: status,
        }));
      }
    }
  });

  // Mount REST API routes from generated server controllers (OpenAPI paths)
  await install(factory, app, 'full.yml', '');
  const port = process.env.PORT || 8888;
  app.listen(port, () => logger.info('REST server listening on port ' + port));
}

main().catch((e: any) => {
  logger.error('Failed to start server', e);
  process.exit(1);
});
""".trimIndent() + "\n"
    }

    /**
     * Convert a hyphenated or lowercase string to PascalCase.
     * "github" → "Github", "github-github" → "GithubGithub"
     */
    private fun pascalCase(input: String): String {
        return input.split("-", "_").joinToString("") { segment ->
            segment.replaceFirstChar { it.uppercase() }
        }
    }
}
