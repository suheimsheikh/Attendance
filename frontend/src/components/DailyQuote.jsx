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
  { t: "You don't have to be great to start, but you have to start to be great.", te: "గొప్పగా ఉండటానికి మొదలుపెట్టాల్సిన అవసరం లేదు, కానీ గొప్పగా అవ్వాలంటే మొదలుపెట్టాలి.", a: "Zig Ziglar" },
  { t: "It is not the ship so much as the skillful sailing that ensures the prosperous voyage.", te: "విజయవంతమైన ప్రయాణాన్ని నౌక కాదు — నేర్పుగల నావికత్వమే నిర్ధారిస్తుంది.", a: "George William Curtis" },
  { t: "Discipline is choosing between what you want now and what you want most.", te: "క్రమశిక్షణ అంటే ఇప్పుడు కావాల్సినదానికీ, చివరికి కావాల్సినదానికీ మధ్య ఎంపిక చేసుకోవడం.", a: "Abraham Lincoln" },
  { t: "Smooth seas do not make skillful sailors.", te: "ప్రశాంతమైన సముద్రాలు నేర్పుగల నావికులను తయారు చేయవు.", a: "African proverb" },
  { t: "A river cuts through rock, not because of its power, but because of its persistence.", te: "నది రాతిని కోస్తుంది — శక్తి వల్ల కాదు, పట్టుదల వల్ల.", a: "James N. Watkins" },
  { t: "The wind and waves are always on the side of the ablest navigator.", te: "గాలి, అలలు ఎల్లప్పుడూ నేర్పుగల నావికుని వైపే ఉంటాయి.", a: "Edward Gibbon" },
  { t: "Champions keep playing until they get it right.", te: "విజేతలు సరిగా వచ్చే వరకు ఆడుతూనే ఉంటారు.", a: "Billie Jean King" },
  { t: "Hard work beats talent when talent doesn't work hard.", te: "ప్రతిభ కష్టపడకపోతే, కష్టపడే మనసు ప్రతిభను ఓడిస్తుంది.", a: "Tim Notke" },
  { t: "Success is the sum of small efforts repeated day in and day out.", te: "విజయం అంటే రోజూ చేసే చిన్న ప్రయత్నాల మొత్తం.", a: "Robert Collier" },
  { t: "Don't watch the clock; do what it does. Keep going.", te: "గడియారాన్ని చూడవద్దు — అది చేసేది చేయండి. ముందుకు సాగండి.", a: "Sam Levenson" },
  { t: "Twenty years from now you will be more disappointed by the things that you didn't do than by the ones you did.", te: "ఇరవై ఏళ్ళ తరువాత చేసిన పనుల కంటే చేయని పనుల వల్ల ఎక్కువగా నిరాశ చెందుతారు.", a: "Mark Twain" },
  { t: "It always seems impossible until it's done.", te: "ఏ పని అయినా పూర్తయ్యే వరకూ అసాధ్యంగానే అనిపిస్తుంది.", a: "Nelson Mandela" },
  { t: "Quality is not an act, it is a habit.", te: "నాణ్యత ఒక చర్య కాదు — అది ఒక అలవాటు.", a: "Aristotle" },
  { t: "The man who moves a mountain begins by carrying away small stones.", te: "పర్వతాన్ని కదిలించేవాడు చిన్న రాళ్లను తీయడంతో మొదలుపెడతాడు.", a: "Confucius" },
  { t: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", te: "మనం పదేపదే చేసేదే మనం. కాబట్టి శ్రేష్ఠత ఒక చర్య కాదు — ఒక అలవాటు.", a: "Will Durant" },
  { t: "Don't let yesterday take up too much of today.", te: "నిన్నటి విషయాలు నేటిని ఎక్కువగా ఆక్రమించనివ్వకండి.", a: "Will Rogers" },
  { t: "Strength does not come from physical capacity. It comes from an indomitable will.", te: "బలం శారీరక సామర్థ్యం నుంచి రాదు — అజేయమైన సంకల్పం నుంచి వస్తుంది.", a: "Mahatma Gandhi" },
  { t: "Energy and persistence conquer all things.", te: "శక్తీ, పట్టుదలా అన్నింటినీ జయిస్తాయి.", a: "Benjamin Franklin" },
  { t: "Adapt your sails to the winds you meet, never the other way around.", te: "ఎదురయ్యే గాలులకు మీ తెరచాపలను సర్దుబాటు చేయండి — గాలులు మిమ్మల్ని కాదు.", a: "Yacht Club of Hyderabad" },
  { t: "The harder the conflict, the more glorious the triumph.", te: "పోరాటం ఎంత కష్టమైతే విజయం అంత గర్వకారణం.", a: "Thomas Paine" },
  { t: "Show up. Show up. Show up. And after a while the muse shows up too.", te: "హాజరవ్వండి. హాజరవ్వండి. హాజరవ్వండి. కొంత కాలానికి స్ఫూర్తి కూడా హాజరవుతుంది.", a: "Isabel Allende" },
  { t: "Pressure is a privilege.", te: "ఒత్తిడి అనేది ఒక గౌరవం.", a: "Billie Jean King" },
  { t: "A goal without a plan is just a wish.", te: "ప్రణాళిక లేని లక్ష్యం కేవలం ఒక కోరిక మాత్రమే.", a: "Antoine de Saint-Exupéry" },
  { t: "It is during our darkest moments that we must focus to see the light.", te: "చీకటి క్షణాల్లోనే వెలుగును చూడటానికి దృష్టి కేంద్రీకరించాలి.", a: "Aristotle" },
  { t: "Excellence is the gradual result of always striving to do better.", te: "శ్రేష్ఠత అంటే ఎల్లప్పుడూ మెరుగుపడేందుకు ప్రయత్నించడం వల్ల వచ్చే క్రమమైన ఫలితం.", a: "Pat Riley" },
  { t: "Don't count the days, make the days count.", te: "రోజులను లెక్కించవద్దు — రోజులను విలువైనవిగా చేయండి.", a: "Muhammad Ali" },
  { t: "Be so good they can't ignore you.", te: "మిమ్మల్ని నిర్లక్ష్యం చేయలేనంత మంచిగా ఉండండి.", a: "Steve Martin" },
  { t: "The expert in anything was once a beginner.", te: "ఏ రంగంలోనైనా నిపుణుడు ఒకప్పుడు పునఃప్రారంభకుడే.", a: "Helen Hayes" },
  { t: "Tough times never last, but tough people do.", te: "కష్టమైన కాలాలు ఎన్నడూ నిలవవు — గట్టి వ్యక్తులు మాత్రం నిలుస్తారు.", a: "Robert H. Schuller" },
  { t: "Discipline weighs ounces, regret weighs tons.", te: "క్రమశిక్షణ కొద్దిగా బరువు — పశ్చాత్తాపం టన్నుల బరువు.", a: "Jim Rohn" },
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
            {quote.te && (
              <p
                className="text-[12.5px] mt-1.5 italic opacity-90 font-medium leading-snug"
                lang="te"
                style={{ fontFamily: "'Noto Sans Telugu', 'Inter', sans-serif" }}
                data-testid="daily-quote-telugu"
              >
                &ldquo;{quote.te}&rdquo;
              </p>
            )}
            <p className="text-[11px] mt-2 opacity-80 font-medium not-italic">— {quote.a}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
