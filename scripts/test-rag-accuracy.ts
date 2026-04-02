import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AskService } from '../src/ask/ask.service';
import { CriticService } from '../src/agent/critic.service';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

async function runEvaluation() {
  console.log('🚀 Starting RAG Evaluation Framework...');
  
  const app = await NestFactory.createApplicationContext(AppModule);
  const askService = app.get(AskService);
  const criticService = app.get(CriticService);

  const datasetPath = path.join(__dirname, '../test/mocks/golden-dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  const results: any[] = [];
  const { conversationId, userId, testCases } = dataset;

  console.log(`📊 evaluating ${testCases.length} test cases for conversation ${conversationId}\n`);

  for (const tc of testCases) {
    console.log(`[${tc.id}] Question: ${tc.question}`);
    
    try {
      // 1. Get Answer from RAG
      const startTime = Date.now();
      const response = await askService.ask(conversationId, userId, tc.question);
      const duration = Date.now() - startTime;

      // 2. Evaluate with Critic
      const context = response.context
        ? (typeof response.context === 'string' 
            ? response.context 
            : response.context.map((m: any) => `[${m.senderName}]: ${m.content}`).join('\n'))
        : '';
        
      const evaluation = await criticService.evaluate({
        question: tc.question,
        context: context,
        answer: response.answer
      });

      const result = {
        id: tc.id,
        category: tc.category,
        question: tc.question,
        expected: tc.expectedFact,
        actual: response.answer,
        verdict: evaluation.verdict,
        groundedness: evaluation.groundedness,
        completeness: evaluation.completeness,
        hallucination_risk: evaluation.hallucination_risk,
        latencyMs: duration,
        reasoning: evaluation.reasoning
      };

      results.push(result);
      
      const statusIcon = result.verdict === 'PASS' ? '✅' : result.verdict === 'FAIL' ? '❌' : '⚠️';
      console.log(`${statusIcon} Verdict: ${result.verdict} | G: ${result.groundedness} | C: ${result.completeness} | Latency: ${duration}ms\n`);

    } catch (err: any) {
      console.error(`❌ Error evaluating ${tc.id}: ${err.message}`);
      results.push({
        id: tc.id,
        question: tc.question,
        error: err.message
      });
    }
  }

  // Generate Report
  const reportDir = path.join(__dirname, '../test-results');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);
  
  const reportPath = path.join(reportDir, `report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: testCases.length,
      pass: results.filter(r => r.verdict === 'PASS').length,
      fail: results.filter(r => r.verdict === 'FAIL').length,
      partial: results.filter(r => r.verdict === 'PARTIAL').length,
    },
    results
  }, null, 2));

  console.log(`\n✨ Evaluation Complete! Report saved to: ${reportPath}`);
  
  // Print summary table
  console.table(results.map(r => ({
    ID: r.id,
    Verdict: r.verdict,
    G: r.groundedness,
    C: r.completeness,
    H: r.hallucination_risk,
    Latency: r.latencyMs
  })));

  await app.close();
  process.exit(0);
}

runEvaluation().catch(err => {
  console.error('Fatal evaluation error:', err);
  process.exit(1);
});
