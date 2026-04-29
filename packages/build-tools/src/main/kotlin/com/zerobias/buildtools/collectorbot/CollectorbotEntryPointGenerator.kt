package com.zerobias.buildtools.collectorbot

import org.gradle.api.GradleException
import java.io.File

object CollectorbotEntryPointGenerator {

    data class PackageIdentity(val scope: String, val name: String) {
        val imageName: String get() = "$scope-$name"
    }

    fun readPackageIdentity(projectDir: File): PackageIdentity {
        val pkgJson = projectDir.resolve("package.json")
        require(pkgJson.exists()) { "package.json not found in $projectDir" }
        val fullName = Regex(""""name"\s*:\s*"([^"]+)"""").find(pkgJson.readText())
            ?.groupValues?.get(1)
            ?: throw GradleException("Cannot find 'name' in ${pkgJson.absolutePath}")
        val match = Regex("""^@([^/]+)/(.+)$""").find(fullName)
            ?: throw GradleException("Package name '$fullName' is not a scoped name (@scope/name)")
        return PackageIdentity(match.groupValues[1], match.groupValues[2])
    }

    fun generate(identity: PackageIdentity): String {
        val pascal = pascalCase(identity.name)
        return """
import 'reflect-metadata';
import axios from 'axios';
import { LoggerEngine } from '@zerobias-org/logger';
import { getClient } from '@zerobias-com/hub-client';
import { container } from './inversify.config.js';

const logger = LoggerEngine.root().get('${pascal}');

const apiKey = process.env.API_KEY!;
const orgId = process.env.ORG_ID!;
const jobId = process.env.JOB_ID!;

async function updateExecutionDetails(
  platformApi: string,
  executionDetails: Record<string, string>
): Promise<void> {
  const target = `${'$'}{platformApi}/dataCollections/${'$'}{jobId}/executionDetails`;
  try {
    await axios.put(target, { executionDetails }, {
      headers: {
        Authorization: `APIKey ${'$'}{apiKey}`,
        'dana-org-id': orgId,
      },
    });
  } catch (err: any) {
    logger.error(`Error updating execution details: ${'$'}{err.message}`);
    logger.error(err);
  }
}

async function sendError(err: any): Promise<void> {
  const callbackUrl = process.env.ERROR_CALLBACK_URL;
  if (!callbackUrl) {
    logger.warning('No error callback url set');
    process.exit(1);
  }
  const data = {
    jobId,
    error: { message: err.message, error: err },
    environment: {
      executionArn: process.env.EXECUTION_ARN,
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      state: process.env.STATE,
    },
  };
  logger.info(`Sending error callback ${'$'}{JSON.stringify(data)}`);
  try {
    await axios.post(callbackUrl, data, {
      headers: {
        Authorization: `APIKey ${'$'}{apiKey}`,
        'dana-org-id': orgId,
      },
    });
  } catch (axiosError: any) {
    logger.error(`Error sending error callback: ${'$'}{axiosError.message}`);
    logger.error(axiosError);
  }
  process.exit(1);
}

(async function main() {
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', err);
  });

  try {
    const params = JSON.parse(process.env.CLIENT_PARAMS || '{}');
    const client = await getClient(container as any);
    const { context } = client as any;
    const platformApi = `${'$'}{context.server.protocol}://${'$'}{context.server.hostname}/platform`;

    await client.run(params);

    const callbackUrl = process.env.COMPLETE_CALLBACK_URL;
    if (!callbackUrl) {
      logger.error('No complete callback url set');
      process.exit(1);
    }
    logger.info('Sending complete callback');
    await updateExecutionDetails(platformApi, {
      status: 'COMPLETE',
      endTime: new Date().toISOString(),
    });
    await axios.put(callbackUrl, {}, {
      headers: {
        Authorization: `APIKey ${'$'}{apiKey}`,
        'dana-org-id': orgId,
      },
    });
    logger.info('Finished');
    process.exit(0);
  } catch (e: any) {
    logger.error('Could not start ${pascal} collectorbot', e);
    await sendError(e);
  }
})();
""".trimIndent() + "\n"
    }

    private fun pascalCase(input: String): String {
        return input.split("-", "_").joinToString("") { segment ->
            segment.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
        }
    }
}
