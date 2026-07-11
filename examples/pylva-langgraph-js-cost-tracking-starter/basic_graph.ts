import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { PylvaCallbackHandler } from '@pylva/sdk/langgraph';

const GraphState = Annotation.Root({
  question: Annotation<string>(),
  answer: Annotation<string>(),
});

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
});

const graph = new StateGraph(GraphState)
  .addNode('answer_question', async (state) => {
    const response = await model.invoke([
      {
        role: 'user',
        content: state.question,
      },
    ]);

    return { answer: String(response.content) };
  })
  .addEdge(START, 'answer_question')
  .addEdge('answer_question', END)
  .compile();

const handler = new PylvaCallbackHandler({
  apiKey: process.env.PYLVA_API_KEY!,
});

const result = await graph.invoke(
  { question: 'Give me one practical way to reduce LLM cost.' },
  {
    callbacks: [handler],
    metadata: { pylva_customer_id: 'cust_acme' },
  },
);

console.log(result.answer);
