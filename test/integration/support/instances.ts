import type { Subprocess } from 'bun';

export interface Instance {
  readonly url: string;
  readonly port: number;
  readonly process: Subprocess;
}

async function waitUntilReady(url: string, process: Subprocess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`instance at ${url} exited with ${process.exitCode}`);
    try {
      if ((await fetch(`${url}/health/ready`)).ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`instance at ${url} was not ready after ${timeoutMs}ms`);
}

function spawnInstance(port: number, env: Record<string, string>, entry = 'src/main.ts'): Instance {
  const process = Bun.spawn({
    cmd: [Bun.argv[0] ?? 'bun', entry],
    env: { ...Bun.env, ...env, PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { url: `http://127.0.0.1:${port}`, port, process };
}

export async function startInstance(
  port: number,
  env: Record<string, string> = {},
  entry = 'src/main.ts',
): Promise<Instance> {
  const instance = spawnInstance(port, env, entry);
  try {
    await waitUntilReady(instance.url, instance.process, 20_000);
  } catch (error) {
    await stopInstances([instance]);
    throw error;
  }
  return instance;
}

export async function startInstances(count: number, env: Record<string, string> = {}): Promise<Instance[]> {
  const basePort = 39_000 + Math.floor(Math.random() * 500) * 2;
  const instances = Array.from({ length: count }, (_, index) => spawnInstance(basePort + index, env));
  try {
    await Promise.all(instances.map((instance) => waitUntilReady(instance.url, instance.process, 20_000)));
  } catch (error) {
    await stopInstances(instances);
    throw error;
  }
  return instances;
}

export async function stopInstances(instances: readonly Instance[] | undefined): Promise<void> {
  if (!instances) return;
  for (const instance of instances) instance.process.kill();
  await Promise.all(instances.map((instance) => instance.process.exited));
}
