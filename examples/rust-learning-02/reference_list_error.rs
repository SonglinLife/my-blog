struct List<'a, T> {
    head: Option<&'a Node<'a, T>>,
}

struct Node<'a, T> {
    elem: T,
    next: Option<&'a Node<'a, T>>,
}

impl<'a, T> List<'a, T> {
    fn new() -> Self {
        List { head: None }
    }

    fn push_front(&mut self, elem: T) {
        let new_node = Node {
            elem,
            next: self.head,
        };

        self.head = Some(&new_node);
    }
}

fn main() {
    let mut list = List::new();
    list.push_front(1);
}
