import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as dotenv from 'dotenv';

// Load env vars explicitly before SDK starts
dotenv.config();

/**
 * OpenTelemetry Instrumentation for Langfuse.
 * This should be imported as the first line in main.ts.
 */
const sdk = new (NodeSDK as any)({
  resource: new (Resource as any)({
    'service.name': 'ai-zalo-agent',
    'service.version': '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  spanProcessor: new (LangfuseSpanProcessor as any)({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: process.env.LANGFUSE_SECRET_KEY || '',
    baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  }),
});

sdk.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
});

export default sdk;
