export type QueuehouseClientConfig = {
  baseUrl: string;
};

export function createQueuehouseClient(_config: QueuehouseClientConfig) {
  return {
    baseUrl: _config.baseUrl,
  };
}
