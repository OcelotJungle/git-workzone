type Task = () => Promise<any>;

export class ConcurrentRunner {
    static run(tasks: Task[], maxPerOneTime = 1) {
        console.debug("concurrent-runner", tasks, maxPerOneTime);

        let done = 0;

        return new Promise<any[]>((resolve, reject) => {
            const results: any[] = [];

            const queue = [...tasks]
                .map((task, i) => [i, task] as const)
                .reverse();

            function runNextFromQueue() {
                const queueTask = queue.pop();

                if (queueTask) {
                    const [i, task] = queueTask;

                    task()
                        .then(result => {
                            results[i] = result;
                            done++;
                        })
                        .catch(reject)
                        .then(runNextFromQueue);
                }
                else {
                    if (done === tasks.length) {
                        console.debug("concurrent-runner resolved", {
                            tasks,
                            results,
                        });

                        resolve(results);
                    }
                }
            }

            for (let i = 0; i < maxPerOneTime; i++) {
                runNextFromQueue();
            }
        });
    }
}
