# Energy Lens

A private electricity tariff simulator for a London household with an electric car. It compares published regional tariffs using either annual totals and editable charging assumptions, or imported half-hourly consumption.

## Run and verify

Node.js 22+ and Python 3 are sufficient. There are no third-party dependencies or build step.

```bash
npm test
npm start
```

Open http://127.0.0.1:18766. Deployable assets are in `dist/`; Sites metadata is in `.openai/hosting.json`.

## Data and privacy

Household bills, Tesla totals, meter readings and account details are deliberately absent from this repository and deployment. Import a private JSON backup or CSV using the interface. The Paste data dialog is an alternative when browser file upload is unavailable. Data and edited assumptions live in browser local storage and can be exported as a private backup. Nothing syncs between devices. Clearing browser storage removes the local copy.

Half-hourly CSVs need interval-start timestamps and consumption in kWh. Optional EV kWh must be a subset of the whole-house reading. Timestamp offsets are preferred. The importer supports column mapping and explicit UTC/Europe-London interpretation; ambiguous local clock-change times are rejected. Cumulative register readings cannot provide time-of-use comparisons.

## Calculation and limits

- Annual mode uses a synthetic average day, preserving annual household and EV consumption. The non-EV night share is allocated uniformly over 23:00–06:00, with the balance spread over other hours. It is an assumption, not observed timing.
- EV use can be scheduled on arrival or into the cheapest eligible intervals within an overnight plug-in window, capped by charger power.
- Measured mode prices each imported half-hour in UK local time. Standing charges cover every calendar day between the first and last readings, including gaps. Missing data is reported and never extrapolated.
- Measured EV rescheduling requires an EV column. Unavailable capacity leaves energy at the original time; partial date ranges should be interpreted cautiously.
- OVO's EV-only price applies only to the EV portion. Incomplete household quotes are not ranked.
- Published prices include applicable VAT and standing charges. Historical bill reconciliation uses the VAT percentage on that bill. Gas, export, batteries, incentives, future exit costs, variable-rate changes and additional smart-dispatch windows are excluded.
- Public regional rates were checked on 17 October 2026. Supplier eligibility and personal availability still require confirmation.

## Files

`engine.mjs` contains pure calculation and import functions; `tariffs.mjs` contains public prices and sources; `app.mjs` handles the UI and browser-local state. Tests cover energy conservation, charge windows and capacity, missing data, both daylight-saving transitions, CSV validation/round-trip, EV-only tariffs, and historical VAT rounding.
