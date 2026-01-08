'use strict';

const { expect } = require('chai');

const { ShoppingItemParser } = require('./parser');

describe('BridgeAlexaShopping parser', () => {
	it('maps locale variants to lexicons', () => {
		const pDe = new ShoppingItemParser({ locale: 'de-DE' });
		expect(pDe.lexiconKey).to.equal('de-de');
		expect(pDe.parse('6x Butter').quantity).to.deep.equal({ val: 6, unit: 'pcs' });

		const pEn = new ShoppingItemParser({ locale: 'en-US' });
		expect(pEn.lexiconKey).to.equal('en-us');
		expect(pEn.parse('5x milk').quantity).to.deep.equal({ val: 5, unit: 'pcs' });
	});

	it('parses multipack with perUnit size (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('6x Lilith Ghee 500g');

		expect(out).to.deep.include({
			name: 'Lilith Ghee',
			quantity: { val: 6, unit: 'pcs' },
			perUnit: { val: 500, unit: 'g' },
		});
		expect(out.confidence).to.be.greaterThan(0.7);
	});

	it('parses count multiplier without perUnit (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('5x denree Rohrohrzucker demeter');

		expect(out).to.deep.include({
			name: 'Denree Rohrohrzucker demeter',
			quantity: { val: 5, unit: 'pcs' },
		});
		expect(out).to.not.have.property('perUnit');
		expect(out.confidence).to.be.greaterThan(0.4);
	});

	it('parses measure-only into perUnit with implicit quantity=1 pcs (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('Sonett 1,5l Color Waschmittel');

		expect(out).to.deep.include({
			name: 'Sonett Color Waschmittel',
			quantity: { val: 1, unit: 'pcs' },
			perUnit: { val: 1.5, unit: 'l' },
		});
	});

	it('parses count-only (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('sechs butter');

		expect(out).to.deep.include({
			name: 'Butter',
			quantity: { val: 6, unit: 'pcs' },
		});
		expect(out).to.not.have.property('perUnit');
	});

	it('parses count-only with explicit packaging (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('siebzehn dosen cola');

		expect(out).to.deep.include({
			name: 'Cola',
			quantity: { val: 17, unit: 'can' },
		});
		expect(out).to.not.have.property('perUnit');
	});

	it('parses count + perUnit + packaging (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('fünf ein liter Becher eis');

		expect(out).to.deep.include({
			name: 'Eis',
			quantity: { val: 5, unit: 'cup' },
			perUnit: { val: 1, unit: 'l' },
		});
	});

	it('parses packaging after measure (de)', () => {
		const p = new ShoppingItemParser({ locale: 'de' });
		const out = p.parse('500g Packung Nudeln');

		expect(out).to.deep.include({
			name: 'Nudeln',
			quantity: { val: 1, unit: 'pack' },
			perUnit: { val: 500, unit: 'g' },
		});
	});
});
