import React, { useEffect, useState } from "react";
import { Quote, X } from "lucide-react";

/**
 * Once-a-day motivational quote shown after a member signs in. We track
 * the last-shown date in localStorage (keyed per user so multiple devices /
 * shared browsers still respect the once-per-day rule). The quote pool is
 * curated for a competitive sailing academy — sailing, sports, discipline,
 * showing-up themes — so it matches the "I-Showed-Up" brand.
 */
const QUOTES = [
  { t: "You don't have to be great to start, but you have to start to be great.", a: "Zig Ziglar" },
  { t: "It is not the ship so much as the skillful sailing that ensures the prosperous voyage.", a: "George William Curtis" },
  { t: "Discipline is choosing between what you want now and what you want most.", a: "Abraham Lincoln" },
  { t: "Smooth seas do not make skillful sailors.", a: "African proverb" },
  { t: "A river cuts through rock, not because of its power, but because of its persistence.", a: "James N. Watkins" },
  { t: "The wind and waves are always on the side of the ablest navigator.", a: "Edward Gibbon" },
  { t: "Champions keep playing until they get it right.", a: "Billie Jean King" },
  { t: "Hard work beats talent when talent doesn't work hard.", a: "Tim Notke" },
  { t: "Success is the sum of small efforts repeated day in and day out.", a: "Robert Collier" },
  { t: "Don't watch the clock; do what it does. Keep going.", a: "Sam Levenson" },
  { t: "Twenty years from now you will be more disappointed by the things that you didn't do than by the ones you did.", a: "Mark Twain" },
  { t: "It always seems impossible until it's done.", a: "Nelson Mandela" },
  { t: "Quality is not an act, it is a habit.", a: "Aristotle" },
  { t: "The man who moves a mountain begins by carrying away small stones.", a: "Confucius" },
  { t: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", a: "Will Durant" },
  { t: "Don't let yesterday take up too much of today.", a: "Will Rogers" },
  { t: "Strength does not come from physical capacity. It comes from an indomitable will.", a: "Mahatma Gandhi" },
  { t: "Energy and persistence conquer all things.", a: "Benjamin Franklin" },
  { t: "Adapt your sails to the winds you meet, never the other way around.", a: "Yacht Club of Hyderabad" },
  { t: "The harder the conflict, the more glorious the triumph.", a: "Thomas Paine" },
  { t: "Show up. Show up. Show up. And after a while the muse shows up too.", a: "Isabel Allende" },
  { t: "Pressure is a privilege.", a: "Billie Jean King" },
  { t: "A goal without a plan is just a wish.", a: "Antoine de Saint-Exupéry" },
  { t: "It is during our darkest moments that we must focus to see the light.", a: "Aristotle" },
  { t: "Excellence is the gradual result of always striving to do better.", a: "Pat Riley" },
  { t: "Don't count the days, make the days count.", a: "Muhammad Ali" },
  { t: "Be so good they can't ignore you.", a: "Steve Martin" },
  { t: "The expert in anything was once a beginner.", a: "Helen Hayes" },
  { t: "Tough times never last, but tough people do.", a: "Robert H. Schuller" },
  { t: "Discipline weighs ounces, regret weighs tons.", a: "Jim Rohn" },
];

function pickDeterministic(userId, dateKey) {
  // Hash (userId + date) → index so the same user sees a stable quote per day,
  // but different members get different quotes on the same day.
  const seed = `${userId || "anon"}|${dateKey}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return QUOTES[h % QUOTES.length];
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function DailyQuote({ userId }) {
  const [visible, setVisible] = useState(false);
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    if (!userId) return;
    const STORAGE_KEY = `ishowedup_quote_${userId}`;
    const lastShown = localStorage.getItem(STORAGE_KEY);
    const today = todayKey();
    if (lastShown === today) return; // already shown today on this device
    setQuote(pickDeterministic(userId, today));
    setVisible(true);
    localStorage.setItem(STORAGE_KEY, today);
  }, [userId]);

  if (!visible || !quote) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 max-w-sm w-[calc(100%-2rem)] md:w-auto"
      data-testid="daily-quote-card"
    >
      <div className="relative bg-gradient-to-br from-sky-500 to-sky-700 text-white rounded-2xl shadow-2xl p-5 pr-10 ring-1 ring-sky-300">
        <button
          onClick={() => setVisible(false)}
          className="absolute top-2 right-2 p-1.5 rounded-full hover:bg-white/20 transition"
          aria-label="Dismiss"
          data-testid="daily-quote-dismiss"
        >
          <X size={14} />
        </button>
        <div className="flex items-start gap-3">
          <Quote size={22} className="opacity-80 shrink-0 mt-0.5" />
          <div className="text-sm leading-snug">
            <p className="font-semibold italic">&ldquo;{quote.t}&rdquo;</p>
            <p className="text-[11px] mt-2 opacity-80 font-medium not-italic">— {quote.a}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
