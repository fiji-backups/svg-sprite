'use strict';

/**
 * svg-sprite is a Node.js module for creating SVG sprites
 *
 * @see https://github.com/jkphl/svg-sprite
 *
 * @author Joschi Kuphal <joschi@kuphal.net> (https://github.com/jkphl)
 * @copyright © 2014 Joschi Kuphal
 * @license MIT https://raw.github.com/jkphl/svg-sprite/master/LICENSE
 */

var _						= require('lodash'),
path						= require('path'),
xmldom						= require('xmldom'),
DOMParser					= xmldom.DOMParser,
XMLSerializer				= xmldom.XMLSerializer,
xpath						= require('xpath'),
cssom						= require('cssom'),
csssp						= require('css-selector-parser').CssSelectorParser,
csssel						= new csssp(),
path						= require('path'),
execFile					= require('child_process').execFile,
phantomjs					= require('phantomjs').path,
dimensionsPhantomScript		= path.resolve(__dirname, 'shape/dimensions.phantom.js'),
async						= require('async'),
defaultConfig				= {
	/**
	 * Shape ID related options
	 * 
	 * @type {Object} 
	 */
	id						: {
		/**
		 * ID part separator (used for directory-to-ID traversal)
		 * 
		 * @type {String}
		 */
		separator			: '--',
		/**
		 * Pseudo selector separator
		 * 
		 * @type {String}
		 */
		pseudo				: '~',
		/**
		 * ID traversal callback
		 * 
		 * @param {String} name				Shape name
		 * @return {String}					Shape ID
		 */
		generator			: function(name) {
			return path.basename(name.split(path.sep).join(this.separator), '.svg');
		}
	},
	/**
	 * Dimension related options
	 * 
	 * @type {Object} 
	 */
	dimension				: {
		/**
		 * Max. shape width
		 * 
		 * @type {Number}
		 */
		maxWidth			: 2000,
		/**
		 * Max. shape height
		 * 
		 * @type {Number}
		 */
		maxHeight			: 2000,
		/**
		 * Coordinate decimal places
		 * 
		 * @type {Number}
		 */
		precision			: 2
	},
	/**
	 * Spacing related options
	 * 
	 * @type {Number} 
	 */
	spacing					: {
		/**
		 * Padding around the shape
		 * 
		 * @type {Number|Array}
		 */
		padding				: {top: 0, right: 0, bottom: 0, left: 0},
		/**
		 * Box sizing strategy
		 * 
		 * Might be 'content' (padding is added outside of the shape) or 'padding' (shape plus padding will make for the given size)
		 * 
		 * @type {String}
		 */
		box					: 'content'
	}
},
svgReferenceProperties		= ['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask',  'marker-start', 'marker-end', 'marker-mid'];

/**
 * SVGShape
 * 
 * @param {File} file					Vinyl file
 * @param {SVGSpriter} spriter			Spriter instance
 */
function SVGShape(file, spriter) {
	this.source				= file;
	this.spriter			= spriter;
	this.svg				= {current: this.source.contents.toString(), ready: null};
	this.name				= this.source.path.substr(this.source.base.length + path.sep.length);
	this.config				= _.merge(_.clone(defaultConfig, true), this.spriter.config.shape || {});
	this.id					= (_.isFunction(this.config.id.generator) ? this.config.id.generator(this.name) : null) || defaultConfig.id.generator(this.name);
	this.state				= this.id.split(this.config.id.pseudo);
	this.base				= this.state.shift();
	this.state				= this.state.shift() || null;
	this._precision			= Math.pow(10, +this.config.dimension.precision);
	this._scale				= 1;
	this._namespaced		= false;

	// Determine meta data
	var relative			= path.basename(this.source.relative, '.svg');
	this.meta				= (this.id in this.config.meta) ? this.config.meta[this.id] : ((relative in this.config.meta) ? this.config.meta[relative] : {});
	
	// Initially set the SVG of this shape
	this._initSVG();
	
	// XML declaration and doctype
	var xmldecl				= this.svg.current.match(/<\?xml.*?>/gi),
	doctype					= this.svg.current.match(/<!DOCTYPE.*?>/gi);
	this.xmlDeclaration		= xmldecl ? xmldecl[0] : '<?xml version="1.0" encoding="utf-8"?>';
	this.doctypeDeclaration	= doctype ? doctype[0] : '';
	
	this.spriter.verbose('Added shape "%s:%s"', this.base, this.state || 'regular');
}

/**
 * Prototype properties
 * 
 * @type {Object} 
 */
SVGShape.prototype = {};

/**
 * SVG stages
 * 
 * @type {Object}
 */
SVGShape.prototype.svg		= null;

/**
 * Default SVG namespace
 * 
 * @type {String}
 */
SVGShape.prototype.DEFAULT_SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Xlink namespace
 * 
 * @type {String}
 */
SVGShape.prototype.XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/**
 * Return a string representation of the shape
 * 
 * @return {String}			String representation
 */
SVGShape.prototype.toString = function() {
	return '[object SVGShape]';
}

/**
 * Recursively strip unneeded namespace declarations
 *  
 * @param {Element} element 	Element
 * @param {Object} nsMap		Namespace map
 * @return {Element}			Element
 */
SVGShape.prototype._stripInlineNamespaceDeclarations = function(element, nsMap) {
	var parentNsMap				= _.clone(element._nsMap);
	nsMap						= nsMap || {'': this.DEFAULT_SVG_NAMESPACE};
	
	// Strip the default SVG namespace
	if (nsMap[''] == this.DEFAULT_SVG_NAMESPACE) {
		var defaultNamespace	= element.attributes.getNamedItem('xmlns');
		if (!_.isUndefined(defaultNamespace) && (defaultNamespace.value == this.DEFAULT_SVG_NAMESPACE)) {
			element.attributes.removeNamedItem('xmlns');
		}
	}
	
	if (!('xlink' in nsMap) || (nsMap.xlink == this.XLINK_NAMESPACE)) {
		var xlinkNamespace		= element.attributes.getNamedItem('xmlns:xlink');
		if (!_.isUndefined(xlinkNamespace) && (xlinkNamespace.value == this.XLINK_NAMESPACE)) {
			element.attributes.removeNamedItem('xmlns:xlink');
		}
	}

	for (var c = 0; c < element.childNodes.length; ++c) {
		if (element.childNodes.item(c).nodeType == 1) {
			this._stripInlineNamespaceDeclarations(element.childNodes.item(c), parentNsMap);
		}
	}
	
	return element;
}

/**
 * Return the SVG of this shape
 * 
 * @param {Boolean}	inline			Prepare for inline usage (strip redundant XML namespaces)
 * @param {Function} transform		Final transformer before serialization (operating on a clone)
 * @return {String}					SVG
 */
SVGShape.prototype.getSVG = function(inline, transform) {
	var svg					= this.dom.documentElement.cloneNode(true);
	
	// Call the final transformer (if available)
	if (_.isFunction(transform)) {
		transform(svg);
	}
	
	// If the SVG is to be used inline or as part of a sprite: Strip redundand namespace declarations
	if (inline) {
		return new XMLSerializer().serializeToString(this._stripInlineNamespaceDeclarations(svg));

	// Else: Add XML and DOCTYPE declarations if required
	} else {
		svg					= new XMLSerializer().serializeToString(svg);
		
		// Add DOCTYPE declaration
		if (this.spriter.config.svg.doctypeDeclaration) {
			svg				= this.doctypeDeclaration + svg;
		}
		
		// Add XML declaration
		if (this.spriter.config.svg.xmlDeclaration) {
			svg				= this.xmlDeclaration + svg;
		}
	}

	return svg;
}

/**
 * Set the SVG of this shape
 * 
 * @param {String} svg		SVG
 * @return {SVGShape}		Self reference
 */
SVGShape.prototype.setSVG = function(svg) {
	this.svg.current		= svg;
	this.svg.ready			= null;
	return this._initSVG();
}

/**
 * Initialize the SVG of this shape
 * 
 * @param {String} svg		SVG
 * @return {SVGShape}		Self reference
 */
SVGShape.prototype._initSVG = function() {
	this.dom				= new DOMParser().parseFromString(this.svg.current);
	
	// Determine the shape width
	var width				= this.dom.documentElement.getAttribute('width');
	this.width				= width.length ? parseFloat(width, 10) : false;
	
	// Determine the shape height
	var height				= this.dom.documentElement.getAttribute('height');
	this.height				= height.length ? parseFloat(height, 10) : false;
	
	// Determine the viewbox
	var viewBox				= this.dom.documentElement.getAttribute('viewBox');
	if (viewBox.length) {
		viewBox				= viewBox.split(/[^\d\.]+/);
		while (viewBox.length < 4) {
			viewBox.push(0);
		}
		viewBox.forEach(function(value, index) {
			viewBox[index]	= parseFloat(value, 10);
		});
		this.viewBox		= viewBox;
	} else {
		this.viewBox		= false;
	}
	
	this.title				=
	this.description		= null;
	for (var c = 0, children = this.dom.documentElement.childNodes, cl = children.length, meta = {title: 'title', description: 'desc'}; c < cl; ++c) {
		for (var m in meta) {
			if (meta[m] == children.item(c).localName) {
				this[m]		= children.item(c);
			}
		}
	}
	
	return this;
}

/**
 * Return the dimensions of this shape
 * 
 * @return {Object}				Dimensions
 */
SVGShape.prototype.getDimensions = function() {
	return {width: this.width, height: this.height};
}

/**
 * Set the dimensions of this shape
 * 
 * @param {Number} width		Width
 * @param {Number} height		Height
 * @return {SVGShape}			Self reference
 */
SVGShape.prototype.setDimensions = function(width, height) {
	this.width				= this._round(Math.max(0, parseFloat(width, 10)));
	this.dom.documentElement.setAttribute('width', this.width);
	this.height				= this._round(Math.max(0, parseFloat(height, 10)));
	this.dom.documentElement.setAttribute('height', this.height);
	return this;
}

/**
 * Return the shape's viewBox (and set it if it doesn't exist yet)
 * 
 * @param {Number} width		Width
 * @param {Height} height		Height
 * @return {Array}				Viewbox
 */
SVGShape.prototype.getViewbox = function(width, height) {
	if (!this.viewBox) {
		this.setViewbox(0, 0, width || this.width, height || this.height);
	}
	return this.viewBox;
}

/**
 * Set the shape's viewBox
 * 
 * @param {Number} x			X coordinate
 * @param {Number} y			Y coordinate
 * @param {Number} width		Width
 * @param {Number} height		Height
 * @return {Array}				Viewbox
 */
SVGShape.prototype.setViewbox = function(x, y, width, height) {
	if (_.isArray(x)) {
		this.viewBox		= x.map(function(n) { return parseFloat(n, 10); });
		while (this.viewBox.length < 4) {
			this.viewBox.push(0);
		}
	} else {
		this.viewBox		= [parseFloat(x, 10), parseFloat(y, 10), parseFloat(width, 10), parseFloat(height, 10)];
	}
	this.dom.documentElement.setAttribute('viewBox', this.viewBox.join(' '));
	return this.viewBox;
}

/**
 * Complement the SVG shape by adding dimensions, padding and meta data
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype.complement = function(cb) {
	var that				= this;
	async.waterfall([
	
		// Prepare dimensions
		this._complementDimensions.bind(this),
		
		// Set padding
		this._addPadding.bind(this),
		
		// Set meta data
		this._addMetadata.bind(this)
		
	], function(error) {
		
		// Save the transformed state
		that.svg.ready		= new XMLSerializer().serializeToString(that.dom.documentElement);
		cb(error, that);
	});
}

/**
 * Complement the shape's dimensions
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype._complementDimensions = function(cb) {
	(this.width && this.height) ?
		this._limitDimensions(cb) :
		this._determineDimensions(this._limitDimensions.bind(this, cb));
}

/**
 * Determine the shape's dimension by rendering it
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype._determineDimensions = function(cb) {
	
	// Try to use a viewBox attribute for image determination
	if (this.viewBox !== false) {
		this.width				= this.viewBox[2];
		this.height				= this.viewBox[3];
	}

	// If the viewBox attribute didn't suffice: Render the SVG image
	if (!this.width || !this.height) {
		var that				= this;
	    execFile(phantomjs, [dimensionsPhantomScript, this.getSVG(false), 'file://' + this.source.path], function (err, stdout, stderr) {
	        if (err) {
	            cb(err);
	        } else if (stdout.length > 0) { // PhantomJS always outputs to stdout.
	        	var dimensions	= JSON.parse(stdout.toString().trim());
	        	that.width		= dimensions.width;
	        	that.height		= dimensions.height;
	        	cb(null);
	        } else if (stderr.length > 0) {
	            cb(new Error(stderr.toString().trim()));
	        } else {
	            cb(new Error('PhantomJS didn\'t return dimensions for "' + that.name + '"'));
	        }
	    });
	} else {
		cb(null);
	}
}

/**
 * Round a number considering the given decimal place precision
 * 
 * @param {Number} n			Number
 * @return {Number}				Rounded number
 */
SVGShape.prototype._round = function(n) {
	return Math.round(n * this._precision) / this._precision;
}

/**
 * Downscale the shape in case it exceeds the limits
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype._limitDimensions = function(cb) {
	
	// Ensure the original viewBox is set
	this.getViewbox(this.width, this.height);
	
	var includePadding		= this.config.spacing.box == 'padding',
	horizontalPadding		= includePadding * Math.max(0, this.config.spacing.padding.right + this.config.spacing.padding.left),
	width					= this.width + horizontalPadding,
	verticalPadding			= includePadding * Math.max(0, this.config.spacing.padding.top + this.config.spacing.padding.bottom),
	height					= this.height + verticalPadding;
	
	// Does the shape need to be downscaled?
	if ((width > this.config.dimension.maxWidth) || (height > this.config.dimension.maxHeight)) {
		var maxWidth		= this.config.dimension.maxWidth - horizontalPadding,
		maxHeight			= this.config.dimension.maxHeight - verticalPadding;
		this._scale			= Math.min(maxWidth / this.width, maxHeight / this.height);
		this.width			= Math.min(maxWidth, this._round(this.width * this._scale));
		this.height			= Math.min(maxHeight, this._round(this.height * this._scale));
	}

	var dimensions			= this.getDimensions();
	for (var attr in dimensions) {
		this.dom.documentElement.setAttribute(attr, dimensions[attr]);
	}
	cb(null);
}


/**
 * Add padding to this shape
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype._addPadding = function(cb) {
	var padding				= this.config.spacing.padding;
	if (padding.top || padding.right || padding.bottom || padding.left) {
		
		// Update viewBox
		var viewBox			= this.getViewbox();
		viewBox[0]			-= this.config.spacing.padding.left / this._scale;
		viewBox[1]			-= this.config.spacing.padding.right / this._scale;
		viewBox[2]			+= (this.config.spacing.padding.right + this.config.spacing.padding.left) / this._scale;
		viewBox[3]			+= (this.config.spacing.padding.top + this.config.spacing.padding.bottom) / this._scale;
		this.setViewbox(viewBox.map(this._round.bind(this)));
		
		// Update dimensions
		this.setDimensions(this.width + this.config.spacing.padding.right + this.config.spacing.padding.left, this.height + this.config.spacing.padding.top + this.config.spacing.padding.bottom);
	}
	cb(null);
}

/**
 * Add metadata to this shape
 * 
 * @param {Function} cb			Callback
 */
SVGShape.prototype._addMetadata = function(cb) {
	var ariaLabelledBy					= []
	
	// Check if description meta data is available
	if (('description' in this.meta) && _.isString(this.meta.description) && this.meta.description.length) {
		if (!this.description) {
			this.description			= this.dom.documentElement.insertBefore(this.dom.createElementNS(this.DEFAULT_SVG_NAMESPACE, 'desc'), this.dom.documentElement.firstChild);
		}
		this.description.textContent	= this.meta.description;
		this.description.setAttribute('id', this.id + '-desc');
		ariaLabelledBy.push(this.id + '-desc');
	}
	
	// Check if title meta data is available
	if (('title' in this.meta) && _.isString(this.meta.title) && this.meta.title.length) {
		if (!this.title) {
			this.title					= this.dom.documentElement.insertBefore(this.dom.createElementNS(this.DEFAULT_SVG_NAMESPACE, 'title'), this.dom.documentElement.firstChild);
		}
		this.title.textContent			= this.meta.title;
		this.title.setAttribute('id', this.id + '-title');
		ariaLabelledBy.push(this.id + '-title');
	}
	
	if (ariaLabelledBy.length) {
		this.dom.documentElement.setAttribute('aria-labelledby', ariaLabelledBy.join(' '));
	} else if (this.dom.documentElement.hasAttribute('aria-labelledby')) {
		this.dom.documentElement.removeAttribute('aria-labelledby');
	}
	
	cb(null);
}

/**
 * Apply a namespace prefix to all IDs within the SVG document
 * 
 * @param {String} ns				ID namespace
 */
SVGShape.prototype.setNamespace = function(ns) {
	if (!this._namespaced) {
		
		// Ensure the shape has been complmented before
		if (!this.svg.ready) {
			var error				= new Error('Shape namespace cannot be set before complementing');
			error.name				= 'NotPermittedError';
			error.errno				= 1419162245;
			throw error;
		}
		
		var select					= xpath.useNamespaces({'svg': this.DEFAULT_SVG_NAMESPACE, 'xlink': this.XLINK_NAMESPACE});
		
		// Build an ID substitution table (and alter the SVG document's IDs accordingly)
		var subst					= {};
		select('//*[@id]', this.dom).forEach(function(elem) {
			var id					= elem.getAttribute('id'),
			substId					= ns + id;
			subst['#' + id]			= substId;
			elem.setAttribute('id', substId);
		});
	
		// Substitute ID references in <style> elements
		var style					= select('//svg:style', this.dom);
		if (style.length) {
			var cssmin				= require('cssmin');
			select('//svg:style', this.dom).forEach(function(style) {
				style.textContent	= cssmin(this._replaceIdReferences(style.textContent, subst, true));
			}, this);
		}
		
		// Substitute ID references in xlink:href attributes
		select('//@xlink:href', this.dom).forEach(function(xlink){
			var xlinkValue			= xlink.nodeValue;
			if ((xlinkValue.indexOf('data:') !== 0) && (xlinkValue in subst)) {
				xlink.ownerElement.setAttribute('xlink:href', '#' + subst[xlinkValue]);
			}
		});
		
		// Substitute ID references in referencing attributes
		svgReferenceProperties.forEach(function(refProperty){
			select('//@' + refProperty, this.dom).forEach(function(ref) {
				ref.ownerElement.setAttribute(ref.localName, this._replaceIdReferences(ref.nodeValue, subst, false))
			}, this);
		}, this);
		
		// Substitute ID references in aria-labelledby attribute
		if (this.dom.documentElement.hasAttribute('aria-labelledby')) {
			this.dom.documentElement.setAttribute('aria-labelledby', this.dom.documentElement.getAttribute('aria-labelledby').split(' ').map(function(label){
				return (('#' + label) in subst) ? subst['#' + label] : label; 
			}).join(' '));
		}
		
		this._namespaced			= true;
	}
}

/**
 * Reset the shapes namespace
 */
SVGShape.prototype.resetNamespace = function() {
	if (this._namespaced) {
		this._namespaced		= false;
		this.dom				= new DOMParser().parseFromString(this.svg.ready);
	}
}

/**
 * Replace an ID reference
 *
 * @param {String} str			String
 * @param {Object} subst		ID substitutions
 * @param {Boolean} selectors	Substitute CSS selectors
 * @return {String}				String with replaced ID references
 */
SVGShape.prototype._replaceIdReferences = function(str, subst, selectors) {

	// Replace url()-style ID references
	str							= str.replace(/url\s*\(\s*["']?([^\)]+)["']?\s*\)/g, function(match, id){
		return 'url(' + ((id in subst) ? ('#' + subst[id]) : id) + ')';
	});

	return selectors ? this._replaceIdReferencesInCssSelectors(str, cssom.parse(str).cssRules, subst) : str;
}

/**
 * Recursively replace ID references in CSS selectors
 *
 * @param {String} str			Original CSS text
 * @param {Array} rules			CSS rules
 * @param {Objec} subst			ID substitutions
 * @return {String}				Substituted CSS text
 */
SVGShape.prototype._replaceIdReferencesInCssSelectors = function(str, rules, subst) {
	var css						= '';
	
	rules.forEach(function(rule) {
		var selText			= rule.selectorText;
		if (_.isUndefined(selText)) {
			if (_.isArray(rule.cssRules)) {
				css				+= str.substring(rule.__starts, rule.cssRules[0].__starts)
								+ this._replaceIdReferencesInCssSelectors(str, rule.cssRules, subst)
								+ str.substring(rule.cssRules[rule.cssRules.length - 1].__ends, rule.__ends);
			}
		} else {
			var origSelText		= selText,
			sel					= csssel.parse(selText),
			ids					= [];
			while ((typeof(sel) == 'object') && ('rule' in sel)) {
				if (('id' in sel.rule) && (('#' + sel.rule.id) in subst)) {
					ids.push(sel.rule.id);
				}
				sel				= sel.rule;
			}
			if (ids.length) {
				ids.sort(function(a, b){
					return b.length - a.length;
				});
				ids.forEach(function(id) {
					selText		= selText.split('#' + id).join('#' + subst['#' + id]);
				}, this);
			}
			css					+= selText + str.substring(rule.__starts + origSelText.length, rule.__ends);
		}
	}, this);

	return css;
}

/**
 * Module export (constructor wrapper)
 * 
 * @param {String} svg			SVG content
 * @param {String} name			Name part or the file path
 * @param {String} file			Absolute file path
 * @param {Object} config		SVG shape configuration
 * @return {SVGShape}			SVGShape instance
 */
module.exports = function(svg, name, file, config) {
	return new SVGShape(svg, name, file, config || {});
}