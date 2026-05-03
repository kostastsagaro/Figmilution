/**
 * CSInterface.js — minimal CEP panel-side bridge for Bridge plugin.
 *
 * How CEP works
 * ─────────────
 * When Illustrator loads a CEP extension the host injects a native object
 * called `window.__adobe_cep__` into every panel's Chromium context.  That
 * object is the only channel into the host application.
 *
 * The canonical Adobe library (adobe/CEP-Resources on GitHub) wraps every
 * CEP API in a large helper class.  We only need two methods, so this is a
 * focused re-implementation:
 *
 *   cs.evalScript(scriptString, callback)
 *       Evaluates `scriptString` in Illustrator's ExtendScript engine.
 *       Calls back with the string return value of the script (or "undefined"
 *       if nothing was returned).  All communication is string-based.
 *
 *   cs.getSystemPath(pathType)
 *       Returns a filesystem path for a well-known location (extension root,
 *       user data dir, etc.).  Useful for constructing file paths in
 *       ExtendScript without hard-coding them.
 *
 * PathType constants (passed to getSystemPath):
 *   0 = UserData         — OS user data directory
 *   1 = CommonFiles      — OS common files directory
 *   2 = MachineName
 *   3 = UserDesktop
 *   4 = RoamingAppData
 *   5 = LocalAppData
 *   6 = OS_EXTENSION (extension root — most useful for us)
 *
 * Usage
 * ─────
 *   <script src="CSInterface.js"></script>   <!-- before panel.js -->
 *   <script src="panel.js"></script>
 *
 *   // inside panel.js (TypeScript declares `class CSInterface` with evalScript)
 *   const cs = new CSInterface();
 *   cs.evalScript('bridge_render(' + JSON.stringify(jsonStr) + ')', (result) => {
 *     const r = JSON.parse(result);
 *   });
 */
(function (global) {
  'use strict';

  function CSInterface() {
    this._cep = global.__adobe_cep__ || null;
    if (!this._cep) {
      console.warn(
        '[Bridge] CSInterface: window.__adobe_cep__ not found. ' +
        'The panel is probably running outside an Adobe CEP host (e.g. a plain browser). ' +
        'evalScript calls will be no-ops.'
      );
    }
  }

  /**
   * Evaluate a script string in the host application's ExtendScript engine.
   *
   * @param {string}   script    ExtendScript source to evaluate.
   * @param {Function} [callback] Receives the string result (or "undefined").
   */
  CSInterface.prototype.evalScript = function (script, callback) {
    if (!this._cep) {
      if (typeof callback === 'function') callback('undefined');
      return;
    }
    if (typeof callback === 'function') {
      this._cep.evalScript(script, callback);
    } else {
      this._cep.evalScript(script, function () {});
    }
  };

  /**
   * Return a filesystem path for a well-known location.
   *
   * @param  {number} pathType  See PathType constants above.
   * @returns {string}
   */
  CSInterface.prototype.getSystemPath = function (pathType) {
    if (!this._cep) return '';
    try {
      var raw = this._cep.getSystemPath(pathType);
      return typeof raw === 'string' ? raw : JSON.parse(raw);
    } catch (e) {
      return '';
    }
  };

  global.CSInterface = CSInterface;

}(typeof window !== 'undefined' ? window : this));
