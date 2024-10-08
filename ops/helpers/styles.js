export const SEGMENT_DEFAULT_BLOCK_STYLES = {
    "blocks": {
        "inline": {
            "all": {
                "wrapper": {
                    "padding": {
                        "start": "base",
                        "end": "base"
                    }
                }
            },
            "blocks": [
                {
                    "type": "reference",
                    "style": {
                        "block": {
                            "rounded": true
                        }
                    }
                },
                {
                    "type": "image",
                    "style": {
                        "block": {
                            "rounded": true
                        }
                    }
                },
                {
                    "type": "collapse",
                    "style": {
                        "block": {
                            "padding": {
                                "top": "none",
                                "bottom": "none",
                                "start": "none",
                                "end": "none"
                            }
                        }
                    }
                }
            ]
        },
        "nested": {
            "all": {
                "wrapper": {
                    "padding": {
                        "start": "none",
                        "end": "none"
                    }
                }
            },
            "blocks": [
                {
                    "type": "list",
                    "style": {
                        "wrapper": {
                            "padding": {
                                "start": "base",
                                "end": "none"
                            }
                        }
                    }
                }
            ]
        }
    },
}