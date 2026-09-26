setInterval(() => {
    $("[tooltip]").each(function () {
        if( !$(this).attr("tooltip-id") ) {
            var this_elm = $(this);
            var text = $(this).attr("tooltip");
            var randomID = Math.random().toString(36).substring(2,7);
            $(this).attr("tooltip-id", randomID);
            var tooltipDIV = $("<div>", {
                text: text,
                id: randomID,
                class: "tooltipElm",
                css: {
                    backgroundColor: "#454545",
                    position: "absolute",
                    color: "#FFF",
                    fontSize: "10px",
                    padding: "3px 6px",
                    borderRadius: "3px",
                    display: "none",
                    zIndex: "10"
                }
            });
            tooltipDIV.appendTo("body");
            $("#" + randomID).css({
                top: $("#" + randomID).offset().top - this_elm.height() - 5,
                left: $("#" + randomID).offset().left - ((tooltipDIV.width() / 2))
            });
        }
    });
    $(".tooltipElm").each(function () {
        var id = $(this).attr("id");
        if( !$("[tooltip-id='" + id + "']").length ) {
            $(this).remove();
        }
    });
}, 10);

$("body").on("mouseover", "[tooltip]", function () {
    var this_elm = $(this);
    var offset = $(this).offset();
    var id = $(this).attr("tooltip-id");
    $("#" + id).show()
    $("#" + id).css({
        top: offset.top - this_elm.height() - 5,
        left: offset.left - (($("#" + id).width() / 2)) + (this_elm.width() / 2)
    });
});
$("body").on("mouseleave", "[tooltip]", function () {
    $("#" + $(this).attr("tooltip-id")).hide();
});