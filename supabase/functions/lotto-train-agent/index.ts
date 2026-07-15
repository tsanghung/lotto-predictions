import { createTrainingHandler } from "./lib/trainingHttp.js";

export const handleTrainingRequest = createTrainingHandler({
  getEnv: (name: string) => Deno.env.get(name),
  fetchFn: fetch,
});

Deno.serve(handleTrainingRequest);
