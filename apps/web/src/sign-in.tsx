import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { signIn } from "./api";

// His sign-in: one password, then back where he was going (`next`, a path on this site only).

/** Where to go after signing in: a same-origin path, else the decisions. */
export const nextOf = (next: unknown) =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/decisions";

export function SignInRoute() {
  const { next } = useSearch({ from: "/sign-in" });
  const [error, setError] = useState("");
  return (
    <form
      className="mx-auto grid min-h-dvh w-[min(320px,calc(100vw-32px))] content-center gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const password = new FormData(e.currentTarget).get("password");
        try {
          await signIn(String(password ?? ""));
          // A full load: the legacy portrait is served by Life, not by the app.
          globalThis.location.assign(nextOf(next));
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h1 className="m-0 mb-3 font-semibold font-serif text-[36px] leading-[1.1]">
        Life
      </h1>
      <input
        autoComplete="current-password"
        autoFocus
        className="field"
        name="password"
        placeholder="Password"
        required
        type="password"
      />
      <button
        className="opt justify-items-center bg-ink font-semibold text-ground"
        type="submit"
      >
        Open
      </button>
      {error ? (
        <p className="m-0 font-mono text-[11.5px] before:text-error before:content-['●_']">
          {error}
        </p>
      ) : null}
    </form>
  );
}
