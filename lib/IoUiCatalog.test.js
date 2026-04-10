'use strict';

const { expect } = require('chai');

const { DEFAULT_COMPOSITION_ID, IoUiCatalog } = require('./IoUiCatalog');

describe('IoUiCatalog', () => {
	let catalog;

	beforeEach(() => {
		catalog = new IoUiCatalog();
	});

	it('returns the default composition when composition mode omits targetId', () => {
		const view = catalog.getView({ mode: 'composition' });
		expect(DEFAULT_COMPOSITION_ID).to.equal('adminTab');
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'adminTab' });
		expect(view.composition.id).to.equal('adminTab');
		expect(view.corePanels).to.have.keys(['messages', 'plugins']);
	});

	it('returns the requested composition and only its core panels', () => {
		const view = catalog.getView({ mode: 'composition', targetId: 'web' });
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'web' });
		expect(view.composition.id).to.equal('web');
		expect(view.composition.panels).to.deep.equal([
			'messages',
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.corePanels).to.have.keys(['messages']);
	});

	it('keeps wildcard compositions model-faithful and expands corePanels asymmetrically', () => {
		const view = catalog.getView({ mode: 'composition', targetId: 'full' });
		expect(view.composition.panels).to.deep.equal(['*']);
		expect(view.corePanels).to.have.keys(['messages', 'plugins']);
	});

	it('builds a synthetic single composition for a core panel target', () => {
		const view = catalog.getView({ mode: 'panel', targetId: 'tab-messages' });
		expect(view.request).to.deep.equal({ mode: 'panel', targetId: 'tab-messages' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-messages',
			layout: 'single',
			panels: ['messages'],
			defaultPanel: 'messages',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.have.keys(['messages']);
	});

	it('builds a synthetic single composition for a plugin panel target without hydrating plugin-owned definitions', () => {
		const view = catalog.getView({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-plugin-IngestStates-0-presets',
			layout: 'single',
			panels: [{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
			defaultPanel: 'plugin-IngestStates-0-presets',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
	});

	it('accepts formally valid but unknown core panel targets without existence checks', () => {
		const view = catalog.getView({ mode: 'panel', targetId: 'tab-unknown' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-unknown',
			layout: 'single',
			panels: ['unknown'],
			defaultPanel: 'unknown',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
	});

	it('rejects invalid requests with BAD_REQUEST', () => {
		expect(() => catalog.getView({})).to.throw().that.has.property('code', 'BAD_REQUEST');
		expect(() => catalog.getView({ mode: 'composition', targetId: 'missing' })).to.throw().that.has.property('code', 'BAD_REQUEST');
		expect(() => catalog.getView({ mode: 'panel' })).to.throw().that.has.property('code', 'BAD_REQUEST');
		expect(() => catalog.getView({ mode: 'panel', targetId: 'bad-target' })).to.throw().that.has.property('code', 'BAD_REQUEST');
		expect(() => catalog.getView({ mode: 'panel', targetId: 'tab-plugin-X-0' })).to.throw().that.has.property('code', 'BAD_REQUEST');
	});
});
