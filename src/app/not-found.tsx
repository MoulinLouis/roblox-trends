import Link from "next/link";

export default function NotFound() {
  return <div className="content"><div className="card empty"><h1>Signal not found</h1><p>This game or trend is no longer in the active dataset.</p><Link className="button primary" href="/">Return to dashboard</Link></div></div>;
}
