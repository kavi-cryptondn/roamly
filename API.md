# Roamly: secure travel data setup

Roamly is a Node.js app that serves its own frontend and exposes these server-side endpoints:

- `GET /api/flights` — Amadeus flight offers.
- `GET /api/hotels` — Amadeus hotel offers with date-specific price/availability when returned.
- `GET /api/weather` — Open-Meteo daily forecast for a destination and stay dates.
- `GET /api/currency` — Frankfurter EUR conversion.
- `GET /api/health` — backend status, without exposing credentials.

The browser never receives Amadeus credentials. Offers are not persisted as itinerary prices; searches are fetched when requested. A missing provider amount or no matching offer remains unavailable, never estimated. Provider results include retrieval times. Currency output retains the original provider amount/currency and adds a separate approximate EUR conversion.

## For the site owner: set up credentials

1. Create an app at [Amadeus for Developers](https://developers.amadeus.com/) and obtain its API key and secret.
2. Install Node.js 18 or newer on the computer/server that will run Roamly.
3. Set these environment variables on the server (use the host's secret/environment-variable settings for deployment; do not put them in the frontend or commit them):

   - `AMADEUS_CLIENT_ID` — Amadeus API key
   - `AMADEUS_CLIENT_SECRET` — Amadeus API secret
   - `AMADEUS_BASE_URL` — use `https://test.api.amadeus.com` for test credentials; production URL `https://api.amadeus.com` only with approved production access
   - `PORT` — optional, defaults to 3000

4. In the project folder run `npm start`, then visit `http://localhost:3000`.
5. The status panel indicates whether the backend sees configured credentials. Amadeus test responses can be limited/sample data; only production credentials can be used to serve genuine production availability.

## Search parameters

Flights: `origin`, `destination` (airport codes or searchable airport names), `departureDate`, optional `returnDate`, `adults`, `children`, `infants`, and `travelClass`.

Hotels: `city` (city name or IATA city code), `checkInDate`, `checkOutDate`, `adults`, `rooms`.

Weather: `city`, `startDate`, `endDate`. Open-Meteo may not provide forecasts for far-future dates; in that case the API explicitly reports forecast unavailable and does not substitute climate estimates.

Currency: `amount`, `currency` (ISO 4217 3-letter currency code). Conversion uses Frankfurter rates and is marked approximate.

## Important hosting note

GitHub Pages is static hosting and cannot run `server.js`. For searches to work online, deploy this project to a Node-capable host, configure the secrets there, and use that host's URL. No credentials were provided in this task, so external travel searches have not been verified. Search results and coverage depend on the provider account, API plan, test/production environment, provider inventory, and quota.
