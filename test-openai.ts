import OpenAI from 'openai';
const client = new OpenAI({ apiKey: 'fake' });
console.log('client.chat:', !!client.chat);
console.log('client.beta:', !!client.beta);
if (client.beta) {
  console.log('client.beta.chat:', !!(client.beta as any).chat);
}
