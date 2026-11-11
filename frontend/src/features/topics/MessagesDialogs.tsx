// MessagesDialogs: the five record-level dialogs of the messages view
// (produce / generate / import / export / delete-records), hosted here so
// MessagesView stays within the structure line budget.
import { ProduceDialog } from "./ProduceDialog.js";
import { GenerateDialog, ExportDialog, ImportDialog } from "./GenerateDialogs.js";
import { DeleteRecordsDialog } from "./DeleteRecordsDialog.js";
import type { TopicDetail } from "../../shared/contracts.js";

export interface MessagesDialogsState {
  producing: boolean;
  generating: boolean;
  importing: boolean;
  exporting: boolean;
  deleting: boolean;
}

interface Props {
  state: MessagesDialogsState;
  ctx: {
    connectionId: string;
    topic: string;
    detail: TopicDetail | null;
    partition: number;
    cursor: "head" | "tail" | { offset: number };
    loadPage: (dir: "head" | "tail" | { offset: number }) => void;
    setProducing: (v: boolean) => void;
    setGenerating: (v: boolean) => void;
    setImporting: (v: boolean) => void;
    setExporting: (v: boolean) => void;
    setDeleting: (v: boolean) => void;
    setCursor: (c: "head" | "tail" | { offset: number }) => void;
  };
}

export function MessagesDialogs({ state, ctx }: Props) {
  const closeAndReload = (close: () => void) => {
    close();
    ctx.setCursor("tail");
    ctx.loadPage("tail");
  };
  return (
    <>
      {state.producing && (
        <ProduceDialog
          connectionId={ctx.connectionId}
          topic={ctx.topic}
          partitions={ctx.detail?.partitionList ?? []}
          onClose={() => {
            ctx.setProducing(false);
            ctx.loadPage(ctx.cursor);
          }}
        />
      )}
      {state.generating && (
        <GenerateDialog
          connectionId={ctx.connectionId}
          topic={ctx.topic}
          onClose={() => closeAndReload(ctx.setGenerating.bind(null, false))}
        />
      )}
      {state.importing && (
        <ImportDialog
          connectionId={ctx.connectionId}
          topic={ctx.topic}
          onClose={() => closeAndReload(ctx.setImporting.bind(null, false))}
        />
      )}
      {state.exporting && (
        <ExportDialog
          connectionId={ctx.connectionId}
          topic={ctx.topic}
          partitions={ctx.detail?.partitionList ?? []}
          defaultPartition={ctx.partition}
          onClose={() => ctx.setExporting(false)}
        />
      )}
      {state.deleting && (
        <DeleteRecordsDialog
          connectionId={ctx.connectionId}
          topic={ctx.topic}
          partitions={ctx.detail?.partitionList ?? []}
          defaultPartition={ctx.partition}
          onClose={() => {
            ctx.setDeleting(false);
            ctx.setCursor("tail"); // deleted region may invalidate the cursor
            ctx.loadPage("tail");
          }}
        />
      )}
    </>
  );
}
