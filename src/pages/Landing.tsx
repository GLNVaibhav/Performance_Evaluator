import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEffect, useRef, useState } from "react";
import {
  motion,
  useInView,
  useMotionValue,
  useTransform,
  animate,
  type Variants,
} from "motion/react";

const PIPELINE = [
  { id: "01", name: "Interpret", desc: "NL goal → structured intent (LLM, optional)" },
  { id: "02", name: "Compile", desc: "Deterministic READY / clarify / reject gate" },
  { id: "03", name: "Approve", desc: "Human review — nothing runs without you" },
  { id: "04", name: "Execute", desc: "k6-style staged traffic, live metric ingest" },
  { id: "05", name: "Explain", desc: "Breaking point, violations, AI analysis" },
];

const FEATURES = [
  {
    title: "Intent, not config",
    body: "Describe the goal in one line. The interpreter maps it onto a strict schema; the compiler turns it into a validated plan with workload safety limits — no YAML, no scripting.",
    tag: "intent",
  },
  {
    title: "Nothing runs without approval",
    body: "Compilation is side-effect-free. A READY plan waits for an explicit human approval step with the target URL confirmed — the same invariant the backend contract enforces.",
    tag: "safety",
  },
  {
    title: "Live traffic ingest",
    body: "Watch VUs, throughput, p50/p95/p99 and errors stream in per second while the run executes — reactive subscriptions, not polling.",
    tag: "live",
  },
  {
    title: "Boundary search built in",
    body: "Stress plans ramp toward a target ceiling and localize the saturation point — the load level where latency doubles and the error budget breaks.",
    tag: "limits",
  },
  {
    title: "Deterministic core",
    body: "The same intent compiles to the same plan, and the same plan reproduces the same evaluation — results you can compare across deploys.",
    tag: "reproducible",
  },
  {
    title: "Explainable verdicts",
    body: "Every run ends with threshold status, violations, and an analysis section: what saturated, what it correlates with, and what to do next.",
    tag: "analysis",
  },
];

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.1 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.21, 0.65, 0.35, 1] } },
};

function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: [0.21, 0.65, 0.35, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Counter({ to, decimals = 0, suffix = "" }: { to: number; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => `${v.toFixed(decimals)}${suffix}`);
  useEffect(() => {
    if (inView) {
      const controls = animate(mv, to, { duration: 1.6, ease: "easeOut" });
      return () => controls.stop();
    }
  }, [inView, mv, to]);
  return <motion.span ref={ref}>{text}</motion.span>;
}

function TypedGoal() {
  const goals = [
    "Baseline /products with 50 users for 30s, p95 under 400ms",
    "Stress /checkout up to 300 users — find the breaking point",
    "Soak /cart for 60s and watch the error budget",
  ];
  const [goalIdx, setGoalIdx] = useState(0);
  const [chars, setChars] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const full = goals[goalIdx];
    const t = window.setTimeout(
      () => {
        if (!deleting) {
          if (chars < full.length) setChars((c) => c + 1);
          else setDeleting(true);
        } else {
          if (chars > 0) setChars((c) => c - 1);
          else {
            setDeleting(false);
            setGoalIdx((i) => (i + 1) % goals.length);
          }
        }
      },
      deleting ? 14 : chars === full.length ? 1600 : 28,
    );
    return () => window.clearTimeout(t);
  }, [chars, deleting, goalIdx, goals]);

  return (
    <span className="font-mono text-sm sm:text-base text-primary/90">
      <span className="text-muted-foreground">mission&gt;</span> {goals[goalIdx].slice(0, chars)}
      <span className="inline-block w-2 h-4 ml-0.5 bg-primary/80 animate-pulse-dot align-middle" />
    </span>
  );
}

/** Animated area chart: staged ramp with a saturation break, k6-summary style. */
function ThroughputChart() {
  const W = 640;
  const H = 140;
  const pts = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const ramp = 18 + 62 * Math.min(1, t * 1.45);
    const sat = t > 0.72 ? -(t - 0.72) * 90 : 0;
    const wobble = 6 * Math.sin(i / 2.6) + 2.5 * Math.sin(i / 1.3);
    return { x: t * W, y: H - Math.max(6, Math.min(H - 8, ramp + sat + wobble)) };
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24 sm:h-28" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="thr-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(160 90% 48%)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="hsl(160 90% 48%)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="hsl(224 18% 15%)" strokeWidth="1" strokeDasharray="3 6" />
      ))}
      <motion.path
        d={area}
        fill="url(#thr-fill)"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.2, delay: 0.5 }}
      />
      <motion.path
        d={line}
        fill="none"
        stroke="hsl(160 90% 48%)"
        strokeWidth="2"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.8, ease: "easeInOut" }}
      />
      <motion.circle
        cx={pts[30].x}
        cy={pts[30].y}
        r="4"
        fill="hsl(45 95% 58%)"
        initial={{ scale: 0, opacity: 0 }}
        whileInView={{ scale: 1, opacity: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 1.35, duration: 0.35, ease: "backOut" }}
      />
    </svg>
  );
}

function SpotlightCTA() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onMouseLeave={() => setPos(null)}
      className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-10 sm:p-14 text-center transition-shadow duration-300"
      style={
        pos
          ? { boxShadow: `0 0 80px -20px hsl(160 90% 48% / 0.4)` }
          : undefined
      }
    >
      {pos && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(360px circle at ${pos.x}px ${pos.y}px, hsl(160 90% 48% / 0.12), transparent 70%)`,
          }}
        />
      )}
      <div className="absolute inset-0 grid-bg opacity-40 pointer-events-none" />
      <div className="relative">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Find the breaking point before your users do.</h2>
        <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
          Sign in, describe your performance goal, approve the plan, and watch the traffic hit.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg" asChild>
            <Link to="/auth">Open mission control</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

const KPIs = [
  { value: 2400, suffix: "+", decimals: 0, label: "peak req/s ingested per run" },
  { value: 80, suffix: "", decimals: 0, label: "VUs staged concurrency" },
  { value: 1, prefix: "<", suffix: "s", decimals: 0, label: "metric granularity, live" },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-clip">
      {/* Nav */}
      <header className="sticky top-0 z-40 glass-panel border-b border-border/60">
        <div className="container flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 border border-primary/30">
              <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse-dot" />
            </span>
            <span className="font-semibold tracking-tight text-lg">Perforso</span>
            <Badge variant="outline" className="hidden sm:inline-flex text-[10px] uppercase tracking-wider text-muted-foreground">
              k6-grade
            </Badge>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4">
            <a href="#pipeline" className="hidden md:inline-flex text-sm text-muted-foreground hover:text-foreground transition-colors">
              Pipeline
            </a>
            <a href="#features" className="hidden md:inline-flex text-sm text-muted-foreground hover:text-foreground transition-colors">
              Why
            </a>
            <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
              <Link to="/auth">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/auth">Launch console</Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="absolute inset-0 grid-bg opacity-60 pointer-events-none" />
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_top,transparent_0%,hsl(var(--background))_78%)]" />
        <div className="absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <motion.div
          className="container relative pt-20 pb-16 sm:pt-28 sm:pb-24"
          variants={container}
          initial="hidden"
          animate="show"
        >
          <div className="max-w-3xl">
            <motion.div variants={item}>
              <Badge variant="success" className="mb-5 font-mono text-[11px]">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
                autonomous evaluation engine · online
              </Badge>
            </motion.div>
            <motion.h1
              variants={item}
              className="text-4xl sm:text-6xl font-bold tracking-tight leading-[1.05]"
            >
              Describe the goal.
              <br />
              <span className="text-gradient">The engine runs the experiment.</span>
            </motion.h1>
            <motion.p
              variants={item}
              className="mt-6 max-w-2xl text-lg text-muted-foreground leading-relaxed"
            >
              Perforso turns a plain-language performance objective into a validated k6-style
              load plan, streams metrics while it executes, and explains exactly where your
              system breaks — with a deterministic, approval-gated pipeline.
            </motion.p>
            <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" asChild>
                <Link to="/auth">Start evaluating — free</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/auth">Watch a live run →</Link>
              </Button>
            </motion.div>
            <motion.div
              variants={item}
              className="mt-8 rounded-lg border border-border/70 bg-card/70 px-4 py-3 glass-panel max-w-xl"
            >
              <TypedGoal />
            </motion.div>
            <motion.div variants={item} className="mt-10 grid grid-cols-3 gap-4 max-w-xl">
              {KPIs.map((k) => (
                <div key={k.label}>
                  <div className="font-mono text-xl sm:text-2xl font-semibold text-foreground">
                    {k.prefix}
                    <Counter to={k.value} decimals={k.decimals} suffix={k.suffix} />
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{k.label}</div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Terminal-style pipeline card */}
          <motion.div
            className="relative mt-14 sm:mt-20"
            initial={{ opacity: 0, y: 40, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.35, ease: [0.21, 0.65, 0.35, 1] }}
          >
            <div className="rounded-xl border border-border/70 glass-panel glow-ring overflow-hidden">
              <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
                <span className="ml-3 font-mono text-xs text-muted-foreground">perforso · mission control</span>
              </div>
              <div className="grid md:grid-cols-5">
                {PIPELINE.map((p, i) => (
                  <motion.div
                    key={p.id}
                    className={`p-5 ${i < PIPELINE.length - 1 ? "md:border-r border-border/50" : ""} border-b md:border-b-0 border-border/50 last:border-b-0`}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.55 + i * 0.12, duration: 0.5 }}
                  >
                    <div className="font-mono text-[11px] text-primary/70">{p.id}</div>
                    <div className="mt-1 font-semibold">{p.name}</div>
                    <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{p.desc}</div>
                  </motion.div>
                ))}
              </div>
              <div className="border-t border-border/60 px-5 py-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[11px] text-muted-foreground">req/s · live ingest</span>
                  <span className="font-mono text-[11px] text-primary">▲ saturating</span>
                </div>
                <ThroughputChart />
              </div>
            </div>
          </motion.div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="container py-16 sm:py-24">
        <Reveal className="max-w-2xl">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            A pipeline you can <span className="text-gradient">trust under load</span>
          </h2>
          <p className="mt-4 text-muted-foreground">
            Borrowed from the k6 playbook, hardened by a contract that separates what the AI
            may decide from what only a human can.
          </p>
        </Reveal>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.08}>
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ type: "spring", stiffness: 300, damping: 24 }}
                className="group h-full rounded-lg border border-border/70 bg-card p-6 transition-colors hover:border-primary/40"
              >
                <div className="font-mono text-[11px] uppercase tracking-widest text-primary/70">{f.tag}</div>
                <h3 className="mt-3 text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.body}</p>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="container pb-24">
        <Reveal>
          <SpotlightCTA />
        </Reveal>
      </section>

      <footer className="border-t border-border/60 py-8">
        <div className="container flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>Perforso — autonomous performance evaluation</span>
          <span className="font-mono text-xs">intent → compile → approve → execute → explain</span>
        </div>
      </footer>
    </div>
  );
}
