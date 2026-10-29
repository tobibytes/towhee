import { Navigate, useParams } from "react-router";
import { Spinner } from "@junco/react";
import { Board } from "./board";
import { newBoardId, useBoardRoom } from "./room";

/** /demo makes a fresh board; /demo/<id> opens one (share the link to collaborate). */
export function DemoNew() {
  return <Navigate to={`/demo/${newBoardId()}`} replace />;
}

export function DemoBoard() {
  const { boardId = "" } = useParams();
  const valid = /^[a-z0-9-]{1,40}$/.test(boardId);
  const room = useBoardRoom(valid ? boardId : "invalid");
  if (!valid) return <Navigate to="/demo" replace />;
  if (!room) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  return <Board room={room} boardId={boardId} />;
}
