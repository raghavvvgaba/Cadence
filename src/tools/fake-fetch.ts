import type { Fetcher } from './info.ts';

// Canned Open-Meteo and Wikipedia responses for simulations, so scenarios get
// the same weather and articles on every run and work without the internet.
// Scenarios rely on these values; change them together with scenarios.yaml.

const CITIES: Record<
  string,
  { name: string; country: string; latitude: number; longitude: number }
> = {
  delhi: { name: 'Delhi', country: 'India', latitude: 28.65, longitude: 77.23 },
  mumbai: { name: 'Mumbai', country: 'India', latitude: 19.07, longitude: 72.88 },
  london: { name: 'London', country: 'United Kingdom', latitude: 51.51, longitude: -0.13 },
};

// Mumbai: rain tomorrow. Everywhere else: dry and sunny.
function forecastFor(latitude: number) {
  const rainy = latitude === CITIES.mumbai!.latitude;
  return {
    current: {
      temperature_2m: 28.4,
      apparent_temperature: 31.2,
      relative_humidity_2m: 70,
      weather_code: 2,
      wind_speed_10m: 9.5,
    },
    daily: {
      time: [
        '2026-11-02',
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
        '2026-11-06',
        '2026-11-07',
        '2026-11-08',
      ],
      weather_code: rainy ? [2, 63, 61, 2, 0, 0, 0] : [0, 0, 1, 2, 0, 0, 0],
      temperature_2m_max: [30.1, 29.2, 28.8, 30.5, 31, 31.2, 30.7],
      temperature_2m_min: [21.3, 22, 21.4, 20.8, 21, 20.5, 20.1],
      precipitation_probability_max: rainy ? [10, 85, 60, 15, 0, 0, 5] : [0, 0, 5, 10, 0, 0, 0],
    },
  };
}

const ARTICLES: Record<
  string,
  { key: string; type: string; description?: string; extract: string }
> = {
  fitts: {
    key: "Fitts's_law",
    type: 'standard',
    description: 'Predictive model of human movement',
    extract:
      "Fitts's law is a predictive model of human movement primarily used in human–computer interaction and ergonomics. The law predicts that the time required to rapidly move to a target area is a function of the ratio between the distance to the target and the width of the target.",
  },
  norman: {
    key: 'Don_Norman',
    type: 'standard',
    description: 'American researcher, professor, and author',
    extract:
      'Donald Arthur Norman is an American researcher, professor, and author. He is best known for his books on design, especially The Design of Everyday Things.',
  },
  // Listed before "mercury" so "Mercury (planet)" matches it first.
  planet: {
    key: 'Mercury_(planet)',
    type: 'standard',
    description: 'First planet from the Sun',
    extract:
      'Mercury is the first planet from the Sun and the smallest in the Solar System. It is a rocky planet with a trace atmosphere.',
  },
  mercury: {
    key: 'Mercury',
    type: 'disambiguation',
    extract:
      'Mercury most commonly refers to:\nMercury (planet), the closest planet to the Sun\nMercury (element), a chemical element\nMercury (mythology), a Roman deity',
  },
};

function findArticle(text: string) {
  const query = text.toLowerCase();
  const match = Object.entries(ARTICLES).find(([word]) => query.includes(word));
  return match?.[1];
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

export const fakeFetch: Fetcher = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const params = url.searchParams;

  if (url.hostname === 'geocoding-api.open-meteo.com') {
    const city = CITIES[(params.get('name') ?? '').toLowerCase().split(',')[0]!.trim()];
    return json(city ? { results: [city] } : {});
  }
  if (url.hostname === 'api.open-meteo.com') {
    return json(forecastFor(Number(params.get('latitude'))));
  }
  if (url.pathname.startsWith('/w/rest.php/v1/search/page')) {
    const article = findArticle(params.get('q') ?? '');
    return json({
      pages: article ? [{ key: article.key, title: article.key.replaceAll('_', ' ') }] : [],
    });
  }
  if (url.pathname.startsWith('/api/rest_v1/page/summary/')) {
    const article = findArticle(decodeURIComponent(url.pathname));
    if (!article) return new Response('Not found', { status: 404 });
    return json({ ...article, title: article.key.replaceAll('_', ' ') });
  }
  if (url.pathname === '/w/api.php') {
    const article = findArticle(params.get('titles') ?? '');
    return json({ query: { pages: [{ extract: article?.extract }] } });
  }
  return new Response('Not found', { status: 404 });
};
