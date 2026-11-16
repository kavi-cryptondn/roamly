# Roamly travel search API

This small Node.js backend is the secure server-side adapter for Amadeus flight and hotel searches. It keeps provider credentials out of the browser and returns provider-sourced offers only. It does not create estimated or fallback prices.

## You need an Amadeus account

Create an application at [Amadeus for Developers](https://developers.amadeus.com/) and obtain its API key and secret. The default configuration uses Amadeus' **test** environment, whose data can be limited or representative rather than live inventory. Do not describe test results as live booking availability. Production access requires Amadeus approval and production credentials.

## Run the API

Install Node.js 18 or newer. In the repository folder, set these server environment variables (never put the secret in `index.html`):

- `AMADEUS_CLIENT_ID` — your API key
- `AMADEUS_CLIENT_SECRET` — your API secret
- `AMADEUS_BASE_URL` — optional; defaults to `https://test.api.amadeus.com`; use `https://api.amadeus.com` only with approved production credentials
- `PORT` — optional; defaults to `3000`
- `ALLOWED_ORIGIN` — optional browser origin allowed to call the API

Then run `npm start` and open `http://localhost:3000/api/health` to check the server. Example searches:

- Flights: `/api/flights?origin=JFK&destination=LHR&departureDate=2027-06-10&adults=1&travelClass=ECONOMY`
- Hotels: `/api/hotels?cityCode=PAR&checkInDate=2027-06-10&checkOutDate=2027-06-13&adults=2&rooms=1`

The hotel route looks up properties by IATA city code and requests offers property-by-property. Provider quotas and test inventory apply. A search with no returned offers stays empty; the API never substitutes a made-up amount. Every response includes provider, environment, and retrieval time.

## Important current scope

This repository's existing UI is a static GitHub Pages page. GitHub Pages cannot run this Node server, so the API needs a separate Node-capable host and the browser UI must be configured to call its URL before users can search it. No Amadeus credentials were supplied, so real searches cannot be verified yet. Flight booking links, hotel booking links, currency conversion, and date-matched forecast/climate presentation are not claimed as implemented by this API scaffold.

Do not commit credentials. For deployment, configure secrets in the hosting provider's environment settings and restrict `ALLOWED_ORIGIN` to the actual website origin.
