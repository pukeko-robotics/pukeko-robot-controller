The compaction and image delta are a solid improvement, but we need a number of follow-ups.

## 1. Improve configuration

We need an improved configuration (similar to Gaunt Sloth config),
where we can specify the configuration in JSON or JS file,
so that we can define the model in a declarative way without playing with environment variables,
potentially we can leverage profiles as well.

## 2. Improve observability

First of all verbose observability should be configurable, so that we don't record this level of details for ordinary sessions.

We need to improve the observability of the system, so that we can tell for sure which messages the model is receiving.

Ideally we want a folder (configurable) which would contain a separate folder for each new turn,
so that we can see actual messages being sent to the model. (This is important since we're doing compaction on almost every tool call.)

Actual images which were sent to the model should also be placed in the folder as an ordinary file (png, jpg, or whichever format it actually is).

## 3. Improve the user experience and DRY

### Indication
Currently, when the model calls the client tool, it first appears like the run has finished: no indication, no spinner,
no thinking block.

In the browser logs we can observe a new run, but in the UI it looks like nothing is happened. 
```
data: {"type":"RUN_STARTED","threadId":"4f5146e1-c5e7-4f37-b712-e26f259d7cef","runId":"60a8f3d0-b6b5-440a-a51a-894cc7730f74"}

data: {"type":"TOOL_CALL_RESULT","toolCallId":"f6a159ba-b108-45cc-a019-48a999539bb7","content":"{\"mimeType\":\"image/jpeg\",\"data\":\"DATA_HERE\",\"motion\":\"turn_right\",\"distanceBefore\":\"24.2\",\"distanceAfter\":\"565.7\"}","role":"tool","messageId":"b6851b0c-4efa-4a1b-891b-b557ae00b1ac"}
```

There could be a delay of many seconds and even minutes before the model will continue streaming thinking:

```
data: {"type":"REASONING_MESSAGE_START","messageId":"88da7f57-20a9-4508-8a11-b8b5f60785f5","role":"reasoning"}

data: {"type":"REASONING_MESSAGE_CONTENT","messageId":"88da7f57-20a9-4508-8a11-b8b5f60785f5","delta":"The"}
```
, etc.

We need to indicate that something is still happening.

I'd replace the rotating spinner with a full-width flat animated bar in the top of the input-area with a status text in the middle (this part is probably better to happen in Galvanized Pukeko)

### New conversation

We need a button to start a new conversation, cleaning history for both server and client (this could be implemented in Galvanized Pukeko)

### Styles

- Maximize the use of Pukeko's styles, get rid of the dark-blue theme, `--bg-primary, #1a1a2e` etc.
- Use PkNavHeader for header so that the pukeko logo is reused.

### Webcam panel to pukeko

Move reusable aspects of the webcam panel and client-tool to pukeko.

## References

In the case we need to modify Gaunt Sloth or Galvanized Pukeko,
we have verdaccio installed in the system to make it easy to modify the dependencies.

We have full source code of the following dependencies:

### Internal tools under our control, which we can modify
../gaunt-sloth-assistant
../galvanized-pukeko-ai-ui

We can and should modify these if it is the most optimal solution.

## 3rd party tools we cannot modify
../langchainjs
../langgraphjs
../ag-ui

We can't modify these, but we can create a PR in dire circumstances.
You may want to update to newer versions of these libraries.

## Testing

Smoke test in the browser, the camera is on, robot is ON. Don't skip testing in browser.
