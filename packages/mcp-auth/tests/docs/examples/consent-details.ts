import type { ConsentPageOptions } from '@grantex/mcp-auth';

export const consentPage: ConsentPageOptions = {
  lang: 'en-GB',
  theme: {
    accentColor: '#0b6e4f',
    textColor: '#111827',
    radiusPx: 4,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  text: {
    title: 'Allow case tools?',
    approve: 'Allow access',
    deny: 'Not now',
  },
  extraCss: '.card{box-shadow:0 1px 3px rgba(0,0,0,.12)}',
  // Replaces the "What you are granting" section. helpers.html escapes every
  // interpolated value; returning a plain string is refused.
  renderDetails: (model, { html }) => html`
    <section aria-labelledby="case-tools">
      <h2 id="case-tools">Case tools for ${model.purpose?.code ?? 'no declared purpose'}</h2>
      <ul>
        ${model.tools.map((tool) => html`<li>${tool.name}${tool.requiresDecision ? ' (needs approval per action)' : ''}</li>`)}
      </ul>
      <p>Data stays in ${model.dataRegion ?? 'any region'} for ${model.duration ?? 'the default duration'}.</p>
    </section>`,
};
