/**
 * A governed tool call, made back through the deployment — abortable.
 *
 * Its own module for the reason `stream.ts` and `respond.ts` are: `index.ts` binds a
 * port at import time, and the part of a tool call worth testing — that a cancelled
 * run stops the request in flight rather than letting the governed action finish for
 * nobody — needs driving without a server.
 *
 * The signal matters more here than anywhere else in this process. A model stream cut
 * off mid-token wastes tokens; a governed action that keeps executing after its run
 * was cancelled is work happening on somebody's computer with no one entitled to it.
 * Aborting the fetch closes the socket, which is the deployment's cue to stop the
 * action it was running on this run's behalf.
 */

export interface DeploymentToolSettings {
  url: string;
  token: string;
}

export async function callDeploymentTool(
  settings: DeploymentToolSettings,
  run: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  if (!settings.token) {
    return "Refused. This Bot has no credential for calling tools back through its deployment.";
  }
  if (!run) {
    /*
     * No statement from the deployment about whose run this is, so there is nothing
     * to act on behalf of. Reported as a result rather than thrown: the run
     * continues and says what it could not do.
     */
    return "Refused. This run carried no signed statement of which Bot and person it is for.";
  }
  try {
    const response = await fetchImplementation(settings.url, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": settings.token,
      },
      /*
       * The deployment's own statement, handed straight back.
       *
       * The Bot and the actor used to be sent from here, which meant this process
       * asserted who it was acting for. It is not in a position to know, and
       * anything holding the token could claim anything, so the deployment says it
       * and this only carries the note.
       */
      body: JSON.stringify({ name, args, run }),
    });
    const body = (await response.json()) as { text?: string };
    return body.text ?? "The tool returned nothing.";
  } catch (error) {
    // Reported to the model as a result rather than thrown: the run continues and
    // says what broke. A cancelled run's graph is being torn down anyway; the
    // sentence is for the transcript, and the closed socket is for the deployment.
    return `That tool could not be called: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
  }
}
